// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain ERC20 used as the underlying for ConfidentialUSDC. 6 decimals to mirror real USDC.
///         Faucet-style: anyone can mint up to 1_000 USDC per call so the demo stays fair.
contract MockUSDC is ERC20 {
    uint256 public constant MAX_MINT_PER_CALL = 1_000 * 1e6;

    constructor() ERC20("Mock USDC", "mUSDC") {
        _mint(msg.sender, 1_000_000 * 1e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        require(amount > 0 && amount <= MAX_MINT_PER_CALL, "amount out of range");
        _mint(to, amount);
    }
}
