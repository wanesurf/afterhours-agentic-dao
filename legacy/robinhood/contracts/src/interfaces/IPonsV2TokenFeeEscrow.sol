// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPonsV2TokenFeeEscrow {
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    function claimToken(address token) external;
}
