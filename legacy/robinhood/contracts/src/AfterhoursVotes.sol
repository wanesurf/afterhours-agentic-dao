// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {ERC20Wrapper} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Wrapper.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title AfterhoursVotes
/// @notice A freely redeemable 1:1 voting wrapper for the existing $AFTERHOURS token.
/// @dev Voting power is opt-in: a holder must delegate to themselves or another account.
contract AfterhoursVotes is ERC20, ERC20Permit, ERC20Votes, ERC20Wrapper {
    error InvalidUnderlying(address underlying);

    constructor(IERC20 underlyingToken)
        ERC20("Afterhours Votes", "vAFTERHOURS")
        ERC20Permit("Afterhours Votes")
        ERC20Wrapper(underlyingToken)
    {
        if (address(underlyingToken) == address(0) || address(underlyingToken).code.length == 0) {
            revert InvalidUnderlying(address(underlyingToken));
        }
    }

    /// @notice Uses timestamps for governance periods so configuration is independent of L2 block cadence.
    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    /// @notice Declares timestamp checkpoints under ERC-6372.
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function decimals() public view override(ERC20, ERC20Wrapper) returns (uint8) {
        return super.decimals();
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
