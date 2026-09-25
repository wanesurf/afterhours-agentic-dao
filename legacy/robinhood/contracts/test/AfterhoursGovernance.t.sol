// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AfterhoursVotes} from "../src/AfterhoursVotes.sol";
import {AfterhoursGovernor} from "../src/AfterhoursGovernor.sol";

interface Vm {
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 newTimestamp) external;
}

contract MockAfterhours is ERC20 {
    constructor() ERC20("Afterhours", "AFTERHOURS") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract GovernedTarget {
    error NotTimelock();

    address public immutable timelock;
    uint256 public value;

    constructor(address timelock_) {
        timelock = timelock_;
    }

    function setValue(uint256 newValue) external {
        if (msg.sender != timelock) revert NotTimelock();
        value = newValue;
    }
}

contract AfterhoursGovernanceTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint48 private constant VOTING_DELAY = 1 days;
    uint32 private constant VOTING_PERIOD = 3 days;
    uint256 private constant TIMELOCK_DELAY = 1 days;
    uint256 private constant QUORUM_PERCENT = 4;

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);

    MockAfterhours private token;
    AfterhoursVotes private votes;
    TimelockController private timelock;
    AfterhoursGovernor private governor;
    GovernedTarget private target;

    function setUp() public {
        vm.warp(1_800_000_000);

        token = new MockAfterhours();
        votes = new AfterhoursVotes(token);

        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(this));
        governor = new AfterhoursGovernor(votes, timelock, VOTING_DELAY, VOTING_PERIOD, 0, QUORUM_PERCENT);

        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(0));
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), address(this));

        target = new GovernedTarget(address(timelock));
        token.mint(ALICE, 1_000 ether);
        token.mint(BOB, 1_000 ether);
    }

    function testWrapDelegateAndUnwrapOneToOne() public {
        _wrapAndDelegate(ALICE, 100 ether);

        _assertEq(votes.balanceOf(ALICE), 100 ether, "wrapped balance");
        _assertEq(votes.getVotes(ALICE), 100 ether, "delegated votes");
        _assertEq(token.balanceOf(address(votes)), 100 ether, "wrapper collateral");

        vm.prank(ALICE);
        votes.withdrawTo(ALICE, 40 ether);

        _assertEq(votes.balanceOf(ALICE), 60 ether, "remaining wrapped balance");
        _assertEq(votes.getVotes(ALICE), 60 ether, "remaining votes");
        _assertEq(token.balanceOf(ALICE), 940 ether, "returned underlying");
        _assertEq(token.balanceOf(address(votes)), votes.totalSupply(), "one-to-one collateral");
    }

    function testVotingPowerComesFromProposalSnapshot() public {
        _wrapAndDelegate(ALICE, 100 ether);
        (uint256 proposalId,,,) = _proposeValue(7, "Set value to seven");

        uint256 snapshot = governor.proposalSnapshot(proposalId);
        vm.warp(snapshot + 1);

        _wrapAndDelegate(BOB, 500 ether);
        vm.prank(ALICE);
        votes.withdrawTo(ALICE, 100 ether);

        vm.prank(ALICE);
        governor.castVote(proposalId, 1);
        vm.prank(BOB);
        governor.castVote(proposalId, 1);

        (, uint256 forVotes,) = governor.proposalVotes(proposalId);
        _assertEq(forVotes, 100 ether, "only snapshot voting power counts");
        _assertEq(votes.balanceOf(ALICE), 0, "alice can unwrap after snapshot");
    }

    function testPassedProposalExecutesOnlyAfterTimelock() public {
        _wrapAndDelegate(ALICE, 100 ether);
        (uint256 proposalId, address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _proposeValue(42, "Set value to forty-two");

        vm.warp(governor.proposalSnapshot(proposalId) + 1);
        vm.prank(ALICE);
        governor.castVote(proposalId, 1);
        vm.warp(governor.proposalDeadline(proposalId) + 1);

        bytes32 descriptionHash = keccak256(bytes("Set value to forty-two"));
        governor.queue(targets, values, calldatas, descriptionHash);
        _assertEq(target.value(), 0, "queued proposal cannot execute early");

        vm.warp(governor.proposalEta(proposalId));
        governor.execute(targets, values, calldatas, descriptionHash);

        _assertEq(target.value(), 42, "timelock executed proposal");
        _assertEq(uint256(governor.state(proposalId)), 7, "proposal executed state");
    }

    function testTimelockRolesAreGovernanceControlled() public view {
        _assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), address(governor)), "governor proposer");
        _assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), address(governor)), "governor canceller");
        _assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)), "execution is permissionless");
        _assertTrue(!timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)), "deployer admin removed");
        _assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)), "timelock self-admin");
    }

    function _wrapAndDelegate(address account, uint256 amount) private {
        vm.startPrank(account);
        token.approve(address(votes), amount);
        votes.depositFor(account, amount);
        votes.delegate(account);
        vm.stopPrank();
    }

    function _proposeValue(uint256 value, string memory description)
        private
        returns (uint256 proposalId, address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        targets = new address[](1);
        values = new uint256[](1);
        calldatas = new bytes[](1);
        targets[0] = address(target);
        calldatas[0] = abi.encodeCall(GovernedTarget.setValue, (value));
        proposalId = governor.propose(targets, values, calldatas, description);
    }

    function _assertEq(uint256 actual, uint256 expected, string memory message) private pure {
        require(actual == expected, message);
    }

    function _assertTrue(bool condition, string memory message) private pure {
        require(condition, message);
    }
}
