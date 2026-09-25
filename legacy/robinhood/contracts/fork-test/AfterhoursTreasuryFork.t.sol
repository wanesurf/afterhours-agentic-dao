// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AfterhoursTreasury} from "../src/AfterhoursTreasury.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPonsV2LaunchFactory.sol";
import {IPonsV2TokenFeeEscrow} from "../src/interfaces/IPonsV2TokenFeeEscrow.sol";

interface ForkVm {
    function deal(address account, uint256 newBalance) external;
    function expectRevert() external;
    function prank(address sender) external;
}

/// @dev Runs only under the `fork` Foundry profile against an Anvil Robinhood Chain fork.
contract AfterhoursTreasuryForkTest {
    ForkVm private constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant ROBINHOOD_CHAIN_ID = 4663;
    address private constant PONS_TOKEN = 0x6918EcC39996DAE959FBb7aAb1F6e926f285eBd4;
    address private constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address private constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address private constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address private constant PONS_FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address private constant AAPL_USDG_POOL = 0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D;
    address private constant UNAUTHORIZED = address(0xBAD);

    IPonsV2LaunchFactory private factory = IPonsV2LaunchFactory(PONS_FACTORY);
    IPonsV2TokenFeeEscrow private escrow = IPonsV2TokenFeeEscrow(PONS_FEE_ESCROW);
    IERC20 private ponsToken = IERC20(PONS_TOKEN);
    IERC20 private usdg = IERC20(USDG);
    IERC20 private aapl = IERC20(AAPL);

    address private originalRecipient;
    AfterhoursTreasury private treasury;

    function setUp() public {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "fork must use Robinhood Chain ID 4663");
        require(PONS_FACTORY.code.length > 0 && PONS_FEE_ESCROW.code.length > 0, "missing live Pons contracts");
        require(AAPL_USDG_POOL.code.length > 0, "missing live AAPL/USDG pool");

        IPonsV2LaunchFactory.LaunchedToken memory launch = factory.getLaunchedToken(PONS_TOKEN);
        require(launch.exists && launch.token == PONS_TOKEN, "live Pons launch mismatch");
        require(launch.pairToken == USDG, "live launch is not USDG paired");
        require(factory.feeEscrow() == PONS_FEE_ESCROW, "live fee escrow mismatch");
        originalRecipient = launch.creatorFeeRecipient;

        treasury = new AfterhoursTreasury(factory, ponsToken, usdg, address(this), address(0));

        // Fork-only impersonation: this mutates only the disposable Anvil state.
        vm.prank(originalRecipient);
        factory.transferCreatorFeeRecipient(PONS_TOKEN, address(treasury));
        _assertEqAddress(treasury.currentCreatorFeeRecipient(), address(treasury), "initial fork cutover");
    }

    function testLivePonsConfigurationAndEscrowInterface() public {
        _assertEqAddress(address(treasury.ponsFactory()), PONS_FACTORY, "factory");
        _assertEqAddress(address(treasury.feeEscrow()), PONS_FEE_ESCROW, "escrow");
        _assertEqAddress(address(treasury.launchedToken()), PONS_TOKEN, "launched token");
        _assertEqAddress(address(treasury.quoteToken()), USDG, "quote token");
        _assertTrue(treasury.paused(), "treasury starts paused");

        uint256 expected = escrow.balanceOfToken(address(treasury), USDG);
        uint256 claimed = treasury.claimCreatorFees();
        _assertEq(expected, 0, "new treasury should have no historical credit");
        _assertEq(claimed, expected, "real escrow claim result");
    }

    function testLiveFactoryRejectsUnauthorizedRecipientRotation() public {
        vm.expectRevert();
        vm.prank(UNAUTHORIZED);
        factory.transferCreatorFeeRecipient(PONS_TOKEN, UNAUTHORIZED);

        _assertEqAddress(treasury.currentCreatorFeeRecipient(), address(treasury), "recipient unchanged");
    }

    function testAtomicMigrationThroughLivePonsFactoryMovesForkAssets() public {
        uint256 usdgAmount = 1_000_000;
        uint256 aaplAmount = 0.1 ether;
        uint256 nativeAmount = 0.002 ether;
        _assertTrue(usdg.balanceOf(AAPL_USDG_POOL) >= usdgAmount, "fork pool needs USDG");
        _assertTrue(aapl.balanceOf(AAPL_USDG_POOL) >= aaplAmount, "fork pool needs AAPL");

        // Fund with tiny amounts impersonated from the live pool only inside the disposable fork.
        vm.prank(AAPL_USDG_POOL);
        _assertTrue(usdg.transfer(address(treasury), usdgAmount), "fork USDG funding");
        vm.prank(AAPL_USDG_POOL);
        _assertTrue(aapl.transfer(address(treasury), aaplAmount), "fork AAPL funding");
        vm.deal(address(treasury), nativeAmount);

        AfterhoursTreasury successor = new AfterhoursTreasury(
            factory, ponsToken, usdg, address(this), address(treasury)
        );
        IERC20[] memory additionalAssets = new IERC20[](1);
        additionalAssets[0] = aapl;

        treasury.migrateTo(payable(address(successor)), additionalAssets);

        _assertTrue(treasury.retired(), "predecessor retired");
        _assertTrue(treasury.paused(), "predecessor remains paused");
        _assertTrue(successor.migrationAccepted(), "successor accepted");
        _assertEqAddress(treasury.successor(), address(successor), "successor recorded");
        _assertEqAddress(successor.currentCreatorFeeRecipient(), address(successor), "Pons recipient rotated");
        _assertEq(usdg.balanceOf(address(treasury)), 0, "old treasury USDG cleared");
        _assertEq(aapl.balanceOf(address(treasury)), 0, "old treasury AAPL cleared");
        _assertEq(address(treasury).balance, 0, "old treasury native cleared");
        _assertEq(usdg.balanceOf(address(successor)), usdgAmount, "successor received USDG");
        _assertEq(aapl.balanceOf(address(successor)), aaplAmount, "successor received AAPL");
        _assertEq(address(successor).balance, nativeAmount, "successor received native token");
    }

    function _assertEq(uint256 actual, uint256 expected, string memory message) private pure {
        require(actual == expected, message);
    }

    function _assertEqAddress(address actual, address expected, string memory message) private pure {
        require(actual == expected, message);
    }

    function _assertTrue(bool condition, string memory message) private pure {
        require(condition, message);
    }
}
