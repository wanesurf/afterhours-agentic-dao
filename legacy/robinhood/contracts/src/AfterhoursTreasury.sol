// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPonsV2LaunchFactory} from "./interfaces/IPonsV2LaunchFactory.sol";
import {IPonsV2TokenFeeEscrow} from "./interfaces/IPonsV2TokenFeeEscrow.sol";

/// @title AfterhoursTreasury
/// @notice Transitional custody and Pons creator-fee collector for the Afterhours DAO.
/// @dev The owner is the temporary administrator. Ownership is two-step and should move to the DAO Timelock
///      after the executor and policy guard are ready. No separate administrator survives that transfer.
contract AfterhoursTreasury is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AlreadyRetired();
    error ClaimAmountMismatch(uint256 expected, uint256 received);
    error CreatorFeeRecipientMismatch(address expected, address actual);
    error CreatorFeeRecipientUpdateFailed(address expected, address actual);
    error InvalidContract(address account);
    error InvalidLaunch(address token, address pairToken);
    error InvalidMigrationSource(address expected, address actual);
    error InvalidSuccessor(address successor);
    error MigrationAlreadyAccepted();
    error MigrationNotAccepted();
    error NotPaused();
    error OwnershipRenunciationDisabled();
    error RetiredTreasury();

    event CreatorFeesClaimed(uint256 amount);
    event CreatorFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient, uint256 claimed);
    event MigrationAccepted(address indexed predecessor, uint256 nativeAmount);
    event MigrationCompleted(address indexed successor, uint256 claimed, uint256 nativeAmount);
    event LegacyAssetsForwarded(address indexed successor, uint256 claimed, uint256 nativeAmount);
    event NativeReceived(address indexed sender, uint256 amount);
    event PausedSet(bool paused);
    event TokenMigrated(address indexed token, address indexed successor, uint256 amount);

    IPonsV2LaunchFactory public immutable ponsFactory;
    IPonsV2TokenFeeEscrow public immutable feeEscrow;
    IERC20 public immutable launchedToken;
    IERC20 public immutable quoteToken;
    address public immutable migrationSource;

    bool public paused = true;
    bool public retired;
    bool public migrationAccepted;
    address payable public successor;

    modifier onlyPaused() {
        if (!paused) revert NotPaused();
        _;
    }

    constructor(
        IPonsV2LaunchFactory ponsFactory_,
        IERC20 launchedToken_,
        IERC20 quoteToken_,
        address initialAdmin,
        address migrationSource_
    ) Ownable(initialAdmin) {
        _requireContract(address(ponsFactory_));
        _requireContract(address(launchedToken_));
        _requireContract(address(quoteToken_));

        address escrow = ponsFactory_.feeEscrow();
        _requireContract(escrow);

        IPonsV2LaunchFactory.LaunchedToken memory launch = ponsFactory_.getLaunchedToken(address(launchedToken_));
        if (!launch.exists || launch.token != address(launchedToken_) || launch.pairToken != address(quoteToken_)) {
            revert InvalidLaunch(address(launchedToken_), address(quoteToken_));
        }
        if (migrationSource_ != address(0)) _requireContract(migrationSource_);

        ponsFactory = ponsFactory_;
        feeEscrow = IPonsV2TokenFeeEscrow(escrow);
        launchedToken = launchedToken_;
        quoteToken = quoteToken_;
        migrationSource = migrationSource_;
    }

    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    /// @notice Returns the recipient currently registered in the Pons launch record.
    function currentCreatorFeeRecipient() public view returns (address) {
        return ponsFactory.getLaunchedToken(address(launchedToken)).creatorFeeRecipient;
    }

    function claimableCreatorFees() external view returns (uint256) {
        return feeEscrow.balanceOfToken(address(this), address(quoteToken));
    }

    /// @notice Pulls this treasury's accrued quote-token fees from the Pons escrow.
    /// @dev Permissionless so a keeper can claim without receiving custody or administrative authority.
    function claimCreatorFees() external nonReentrant returns (uint256 claimed) {
        claimed = _claimCreatorFees();
    }

    /// @notice Pauses or resumes treasury operations controlled by this contract.
    /// @dev A retired treasury can never be resumed.
    function setPaused(bool paused_) external onlyOwner {
        if (retired && !paused_) revert RetiredTreasury();
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Retires this treasury, redirects creator fees, and moves custody to a checked successor.
    /// @param successor_ A predeployed AfterhoursTreasury whose migrationSource is this contract.
    /// @param additionalAssets Stock Tokens and any other ERC-20 assets to move. quoteToken moves automatically.
    function migrateTo(address payable successor_, IERC20[] calldata additionalAssets)
        external
        onlyOwner
        onlyPaused
        nonReentrant
    {
        if (retired) revert AlreadyRetired();
        _validateSuccessor(successor_);
        _requireCurrentCreatorFeeRecipient(address(this));

        uint256 claimed = _claimCreatorFees();
        retired = true;
        successor = successor_;

        ponsFactory.transferCreatorFeeRecipient(address(launchedToken), successor_);
        address registered = currentCreatorFeeRecipient();
        if (registered != successor_) revert CreatorFeeRecipientUpdateFailed(successor_, registered);
        emit CreatorFeeRecipientUpdated(address(this), successor_, claimed);

        _migrateToken(quoteToken, successor_);
        for (uint256 i = 0; i < additionalAssets.length; ++i) {
            if (address(additionalAssets[i]) != address(quoteToken)) {
                _migrateToken(additionalAssets[i], successor_);
            }
        }

        uint256 nativeAmount = address(this).balance;
        AfterhoursTreasury(successor_).acceptMigration{value: nativeAmount}();
        emit MigrationCompleted(successor_, claimed, nativeAmount);
    }

    /// @notice Accepts the initial migration from the predecessor fixed at deployment.
    function acceptMigration() external payable nonReentrant {
        if (migrationAccepted) revert MigrationAlreadyAccepted();
        if (msg.sender != migrationSource) revert InvalidMigrationSource(migrationSource, msg.sender);

        AfterhoursTreasury predecessor = AfterhoursTreasury(payable(msg.sender));
        if (
            !predecessor.retired() || predecessor.successor() != address(this) || predecessor.owner() != owner()
                || address(predecessor.ponsFactory()) != address(ponsFactory)
                || address(predecessor.feeEscrow()) != address(feeEscrow)
                || address(predecessor.launchedToken()) != address(launchedToken)
                || address(predecessor.quoteToken()) != address(quoteToken)
        ) revert InvalidSuccessor(address(this));
        _requireCurrentCreatorFeeRecipient(address(this));

        migrationAccepted = true;
        emit MigrationAccepted(msg.sender, msg.value);
    }

    /// @notice Moves balances received by a retired treasury after its initial migration.
    function forwardLegacyAssets(IERC20[] calldata additionalAssets) external onlyOwner nonReentrant {
        if (!retired || successor == address(0)) revert InvalidSuccessor(successor);
        AfterhoursTreasury next = AfterhoursTreasury(successor);
        if (!next.migrationAccepted()) revert MigrationNotAccepted();

        uint256 claimed = _claimCreatorFees();
        _migrateToken(quoteToken, successor);
        for (uint256 i = 0; i < additionalAssets.length; ++i) {
            if (address(additionalAssets[i]) != address(quoteToken)) {
                _migrateToken(additionalAssets[i], successor);
            }
        }

        uint256 nativeAmount = address(this).balance;
        next.acceptLegacyMigration{value: nativeAmount}();
        emit LegacyAssetsForwarded(successor, claimed, nativeAmount);
    }

    /// @notice Accepts later balances only from the configured predecessor after the initial migration.
    function acceptLegacyMigration() external payable nonReentrant {
        if (!migrationAccepted) revert MigrationNotAccepted();
        if (msg.sender != migrationSource) revert InvalidMigrationSource(migrationSource, msg.sender);
        emit MigrationAccepted(msg.sender, msg.value);
    }

    /// @dev Prevents accidentally stranding administrative functions. Transfer ownership to the Timelock instead.
    function renounceOwnership() public pure override {
        revert OwnershipRenunciationDisabled();
    }

    function _claimCreatorFees() private returns (uint256 claimed) {
        uint256 expected = feeEscrow.balanceOfToken(address(this), address(quoteToken));
        if (expected == 0) {
            emit CreatorFeesClaimed(0);
            return 0;
        }

        uint256 beforeBalance = quoteToken.balanceOf(address(this));
        feeEscrow.claimToken(address(quoteToken));
        uint256 afterBalance = quoteToken.balanceOf(address(this));
        claimed = afterBalance > beforeBalance ? afterBalance - beforeBalance : 0;
        if (claimed != expected) revert ClaimAmountMismatch(expected, claimed);
        emit CreatorFeesClaimed(claimed);
    }

    function _validateSuccessor(address payable successor_) private view {
        if (successor_ == address(0) || successor_ == address(this) || successor_.code.length == 0) {
            revert InvalidSuccessor(successor_);
        }

        AfterhoursTreasury next = AfterhoursTreasury(successor_);
        if (
            next.migrationSource() != address(this) || next.owner() != owner() || !next.paused() || next.retired()
                || next.migrationAccepted() || address(next.ponsFactory()) != address(ponsFactory)
                || address(next.feeEscrow()) != address(feeEscrow)
                || address(next.launchedToken()) != address(launchedToken)
                || address(next.quoteToken()) != address(quoteToken)
        ) revert InvalidSuccessor(successor_);
    }

    function _migrateToken(IERC20 asset, address recipient) private {
        _requireContract(address(asset));
        uint256 amount = asset.balanceOf(address(this));
        if (amount == 0) return;
        asset.safeTransfer(recipient, amount);
        emit TokenMigrated(address(asset), recipient, amount);
    }

    function _requireCurrentCreatorFeeRecipient(address expected) private view {
        address actual = currentCreatorFeeRecipient();
        if (actual != expected) revert CreatorFeeRecipientMismatch(expected, actual);
    }

    function _requireContract(address account) private view {
        if (account == address(0) || account.code.length == 0) revert InvalidContract(account);
    }
}
