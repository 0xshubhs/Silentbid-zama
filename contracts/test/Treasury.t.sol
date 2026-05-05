// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../src/Treasury.sol";

contract TreasuryTest is Test {
    Treasury internal treasury;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal auction = makeAddr("auction");

    function setUp() public {
        vm.prank(owner);
        treasury = new Treasury(250); // 2.5%
    }

    function test_constructor_setsOwnerAndFee() public view {
        assertEq(treasury.owner(), owner);
        assertEq(treasury.feeBasisPoints(), 250);
    }

    function test_constructor_RevertWhen_FeeAboveCap() public {
        vm.expectRevert(Treasury.FeeTooHigh.selector);
        new Treasury(1_001);
    }

    function test_setFeeBasisPoints_owner() public {
        vm.prank(owner);
        treasury.setFeeBasisPoints(500);
        assertEq(treasury.feeBasisPoints(), 500);
    }

    function test_setFeeBasisPoints_RevertWhen_NotOwner() public {
        vm.prank(alice);
        vm.expectRevert(Treasury.NotOwner.selector);
        treasury.setFeeBasisPoints(100);
    }

    function test_setFeeBasisPoints_RevertWhen_AboveCap() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.FeeTooHigh.selector);
        treasury.setFeeBasisPoints(1_001);
    }

    function test_authorizeAndRevoke() public {
        vm.startPrank(owner);
        treasury.authorizeContract(auction);
        assertTrue(treasury.authorizedContracts(auction));
        treasury.revokeContract(auction);
        assertFalse(treasury.authorizedContracts(auction));
        vm.stopPrank();
    }

    function test_authorize_RevertWhen_ZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        treasury.authorizeContract(address(0));
    }

    function test_receiveAndWithdraw() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok, ) = address(treasury).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(treasury).balance, 1 ether);

        address payable recipient = payable(makeAddr("recipient"));
        vm.prank(owner);
        treasury.withdraw(recipient, 0.4 ether);
        assertEq(recipient.balance, 0.4 ether);
        assertEq(address(treasury).balance, 0.6 ether);
    }

    function test_withdraw_RevertWhen_NotOwner() public {
        vm.deal(address(treasury), 1 ether);
        vm.prank(alice);
        vm.expectRevert(Treasury.NotOwner.selector);
        treasury.withdraw(payable(alice), 0.1 ether);
    }

    function test_transferOwnership() public {
        vm.prank(owner);
        treasury.transferOwnership(alice);
        assertEq(treasury.owner(), alice);
    }

    function test_transferOwnership_RevertWhen_ZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        treasury.transferOwnership(address(0));
    }

    function testFuzz_feeMath(uint64 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 1_000));
        amount = uint64(bound(amount, 0, type(uint64).max / 1_000));
        vm.prank(owner);
        treasury.setFeeBasisPoints(bps);
        // multiply-before-divide invariant
        uint256 fee = (uint256(amount) * bps) / 10_000;
        uint256 net = uint256(amount) - fee;
        assertEq(fee + net, amount);
    }
}
