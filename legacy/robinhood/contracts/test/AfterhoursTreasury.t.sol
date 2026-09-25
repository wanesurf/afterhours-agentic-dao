// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AfterhoursTreasury} from "../src/AfterhoursTreasury.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPonsV2LaunchFactory.sol";
import {IPonsV2TokenFeeEscrow} from "../src/interfaces/IPonsV2TokenFeeEscrow.sol";

interface TreasuryVm {
    function deal(address account, uint256 newBalance) external;
    function expectRevert() external;
    function prank(address sender) external;
}

contract MockTreasuryAsset is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract MockPonsTokenFeeEscrow is IPonsV2TokenFeeEscrow {
    using AddressKey for mapping(bytes32 => uint256);
    using SafeERC20 for IERC20;

    mapping(bytes32 => uint256) private credits;

    function balanceOfToken(address recipient, address token) external view returns (uint256) {
        return credits.get(recipient, token);
    }

    function credit(address recipient, address token, uint256 amount) external {
        credits.set(recipient, token, credits.get(recipient, token) + amount);
    }

    function claimToken(address token) external {
        uint256 amount = credits.get(msg.sender, token);
        credits.set(msg.sender, token, 0);
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}

library AddressKey {
    function key(address recipient, address token) internal pure returns (bytes32) {
        return keccak256(abi.encode(recipient, token));
    }

    function get(mapping(bytes32 => uint256) storage values, address recipient, address token)
        internal
        view
        returns (uint256)
    {
        return values[key(recipient, token)];
    }

    function set(mapping(bytes32 => uint256) storage values, address recipient, address token, uint256 amount)
        internal
    {
        values[key(recipient, token)] = amount;
    }
}

contract MockPonsLaunchFactory is IPonsV2LaunchFactory {
    error NotCurrentRecipient();

    address public immutable override feeEscrow;
    mapping(address => LaunchedToken) private launches;

    constructor(address feeEscrow_) {
        feeEscrow = feeEscrow_;
    }

    function configure(address token, address pairToken, address creatorFeeRecipient) external {
        launches[token] = LaunchedToken({
            token: token,
            curve: address(0xC0Fe),
            deployer: msg.sender,
            creatorFeeRecipient: creatorFeeRecipient,
            pairToken: pairToken,
            graduationThreshold: 0,
            poolFee: 500,
            tickSpacing: 10,
            creatorTaxBps: 100,
            buybackEnabled: false,
            phase: 1,
            sweptQuote: 0,
            sweptTokens: 0,
            sweptAt: 0,
            exists: true
        });
    }

    function setRecipientForTest(address token, address recipient) external {
        launches[token].creatorFeeRecipient = recipient;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory) {
        return launches[token];
    }

    function transferCreatorFeeRecipient(address token, address newRecipient) external {
        if (launches[token].creatorFeeRecipient != msg.sender) revert NotCurrentRecipient();
        launches[token].creatorFeeRecipient = newRecipient;
    }
}

    contract AfterhoursTreasuryTest {
        TreasuryVm private constant vm = TreasuryVm(address(uint160(uint256(keccak256("hevm cheat code")))));

        address private constant BOB = address(0xB0B);

        MockTreasuryAsset private ponsToken;
        MockTreasuryAsset private quoteToken;
        MockTreasuryAsset private stockToken;
        MockPonsTokenFeeEscrow private escrow;
        MockPonsLaunchFactory private factory;
        AfterhoursTreasury private treasury;

        function setUp() public {
            ponsToken = new MockTreasuryAsset("Afterhours", "AFTERHOURS");
            quoteToken = new MockTreasuryAsset("Global Dollar", "USDG");
            stockToken = new MockTreasuryAsset("Apple Stock Token", "AAPL");
            escrow = new MockPonsTokenFeeEscrow();
            factory = new MockPonsLaunchFactory(address(escrow));
            factory.configure(address(ponsToken), address(quoteToken), address(this));

            treasury = new AfterhoursTreasury(factory, ponsToken, quoteToken, address(this), address(0));
            factory.setRecipientForTest(address(ponsToken), address(treasury));
        }

        function testPermissionlessClaimReceivesExactCreatorFees() public {
            _creditFees(address(treasury), 125 ether);

            vm.prank(BOB);
            uint256 claimed = treasury.claimCreatorFees();

            _assertEq(claimed, 125 ether, "claimed amount");
            _assertEq(quoteToken.balanceOf(address(treasury)), 125 ether, "treasury quote balance");
            _assertEq(treasury.claimableCreatorFees(), 0, "escrow credit cleared");
        }

        function testNonAdminCannotMigrateOrEditCreatorFeeRecipient() public {
            AfterhoursTreasury next = _newSuccessor(address(treasury));
            IERC20[] memory assets = new IERC20[](0);

            vm.expectRevert();
            vm.prank(BOB);
            treasury.migrateTo(payable(address(next)), assets);
        }

        function testMigrationRequiresPause() public {
            AfterhoursTreasury next = _newSuccessor(address(treasury));
            IERC20[] memory assets = new IERC20[](0);
            treasury.setPaused(false);

            vm.expectRevert();
            treasury.migrateTo(payable(address(next)), assets);

            _assertTrue(!treasury.retired(), "active treasury retained");
            _assertEqAddress(treasury.currentCreatorFeeRecipient(), address(treasury), "recipient unchanged");
        }

        function testCheckedMigrationMovesFeesAssetsNativeAndRecipient() public {
            AfterhoursTreasury next = _newSuccessor(address(treasury));
            _creditFees(address(treasury), 20 ether);
            quoteToken.mint(address(treasury), 100 ether);
            stockToken.mint(address(treasury), 7 ether);
            vm.deal(address(treasury), 2 ether);

            IERC20[] memory assets = new IERC20[](1);
            assets[0] = stockToken;
            treasury.migrateTo(payable(address(next)), assets);

            _assertTrue(treasury.retired(), "predecessor retired");
            _assertTrue(treasury.paused(), "predecessor paused");
            _assertTrue(next.migrationAccepted(), "successor accepted");
            _assertEqAddress(treasury.successor(), address(next), "successor recorded");
            _assertEqAddress(next.currentCreatorFeeRecipient(), address(next), "fees redirected");
            _assertEq(quoteToken.balanceOf(address(next)), 120 ether, "quote moved");
            _assertEq(stockToken.balanceOf(address(next)), 7 ether, "stock moved");
            _assertEq(address(next).balance, 2 ether, "native moved");
            _assertEq(address(treasury).balance, 0, "predecessor native cleared");
        }

        function testMigrationRejectsUncheckedSuccessor() public {
            AfterhoursTreasury unrelated = _newSuccessor(address(0));
            IERC20[] memory assets = new IERC20[](0);

            vm.expectRevert();
            treasury.migrateTo(payable(address(unrelated)), assets);
            _assertTrue(!treasury.retired(), "failed migration rolled back");
            _assertEqAddress(treasury.currentCreatorFeeRecipient(), address(treasury), "recipient unchanged");
        }

        function testRetiredTreasuryCanForwardLateBalances() public {
            AfterhoursTreasury next = _newSuccessor(address(treasury));
            IERC20[] memory assets = new IERC20[](1);
            assets[0] = stockToken;
            treasury.migrateTo(payable(address(next)), assets);

            _creditFees(address(treasury), 5 ether);
            quoteToken.mint(address(treasury), 3 ether);
            stockToken.mint(address(treasury), 2 ether);
            vm.deal(address(treasury), 1 ether);
            treasury.forwardLegacyAssets(assets);

            _assertEq(quoteToken.balanceOf(address(next)), 8 ether, "late quote and fees moved");
            _assertEq(stockToken.balanceOf(address(next)), 2 ether, "late stock moved");
            _assertEq(address(next).balance, 1 ether, "late native moved");
        }

        function testTwoStepAdminTransferRemovesPreviousAdmin() public {
            treasury.transferOwnership(BOB);
            _assertEqAddress(treasury.owner(), address(this), "owner unchanged before accept");

            vm.prank(BOB);
            treasury.acceptOwnership();
            _assertEqAddress(treasury.owner(), BOB, "new owner accepted");

            vm.expectRevert();
            treasury.setPaused(false);
            vm.prank(BOB);
            treasury.setPaused(false);
            _assertTrue(!treasury.paused(), "new owner controls pause");
        }

        function testOwnershipCannotBeRenouncedAndStrandMigration() public {
            vm.expectRevert();
            treasury.renounceOwnership();
            _assertEqAddress(treasury.owner(), address(this), "owner retained");
        }

        function _newSuccessor(address source) private returns (AfterhoursTreasury) {
            return new AfterhoursTreasury(factory, ponsToken, quoteToken, address(this), source);
        }

        function _creditFees(address recipient, uint256 amount) private {
            quoteToken.mint(address(escrow), amount);
            escrow.credit(recipient, address(quoteToken), amount);
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
