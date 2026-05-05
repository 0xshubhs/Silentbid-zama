// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockTokenX} from "../src/MockTokenX.sol";

contract MockTokensTest is Test {
    MockUSDC internal usdc;
    MockTokenX internal tokenX;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
        tokenX = new MockTokenX("TokenX", "TKX", 1_000_000 ether);
    }

    function test_usdc_decimals() public view {
        assertEq(usdc.decimals(), 6);
    }

    function test_usdc_initialMintToDeployer() public view {
        assertEq(usdc.balanceOf(address(this)), 1_000_000 * 1e6);
    }

    function test_usdc_mintWithinCap() public {
        usdc.mint(alice, 1_000 * 1e6);
        assertEq(usdc.balanceOf(alice), 1_000 * 1e6);
    }

    function test_usdc_RevertWhen_MintAboveCap() public {
        vm.expectRevert("amount out of range");
        usdc.mint(alice, 1_001 * 1e6);
    }

    function test_usdc_RevertWhen_MintZero() public {
        vm.expectRevert("amount out of range");
        usdc.mint(alice, 0);
    }

    function test_tokenX_decimals_default18() public view {
        assertEq(tokenX.decimals(), 18);
    }

    function test_tokenX_initialSupply() public view {
        assertEq(tokenX.balanceOf(address(this)), 1_000_000 ether);
        assertEq(tokenX.totalSupply(), 1_000_000 ether);
    }

    function test_tokenX_mint() public {
        tokenX.mint(bob, 5 ether);
        assertEq(tokenX.balanceOf(bob), 5 ether);
    }

    function testFuzz_usdcMint(address to, uint256 amount) public {
        vm.assume(to != address(0));
        amount = bound(amount, 1, 1_000 * 1e6);
        uint256 before = usdc.balanceOf(to);
        usdc.mint(to, amount);
        assertEq(usdc.balanceOf(to), before + amount);
    }
}
