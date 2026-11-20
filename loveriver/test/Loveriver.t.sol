// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Loveriver} from "../src/Loveriver.sol";

contract LoveriverTest is Test {
    Loveriver token;

    address owner = address(0xA11CE);
    address feeWallet = address(0xFEE);
    address newFeeWallet = address(0x9E1);
    address alice = address(0xB0B);
    address bob = address(0xCA401);

    address[5] admins = [
        address(0xAD1),
        address(0xAD2),
        address(0xAD3),
        address(0xAD4),
        address(0xAD5)
    ];

    uint256 constant TOP_SUPPLY = 699_999_999_999e18;

    function setUp() public {
        token = new Loveriver(owner, admins, feeWallet, 100); // 1%
        vm.prank(owner);
        token.mint(alice, TOP_SUPPLY * 10);
    }

    /// The chosen policy: minting is uncapped, so "top supply four times" is legal.
    function test_UnlimitedMint_NoCap() public {
        uint256 before = token.totalSupply();
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(owner);
            token.mint(bob, TOP_SUPPLY);
        }
        assertEq(token.totalSupply(), before + 4 * TOP_SUPPLY);
        assertEq(token.balanceOf(bob), 4 * TOP_SUPPLY);
        // Four times the "max supply" is above it, and nothing reverts: that is the point.
        assertGt(token.totalSupply(), 4 * TOP_SUPPLY);
    }

    function test_MintIsOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Loveriver.NotOwner.selector, alice));
        token.mint(alice, 1e18);
    }

    function test_TransferChargesFeeInTheTokenItself() public {
        vm.prank(alice);
        token.transfer(bob, 100e18);

        assertEq(token.balanceOf(bob), 99e18, "recipient receives the amount minus fee");
        assertEq(token.balanceOf(feeWallet), 1e18, "fee lands in the fee wallet");
    }

    function test_MovingOutOfFeeWalletIsFree() public {
        vm.prank(alice);
        token.transfer(bob, 100e18); // 1e18 accrued as fee

        vm.prank(feeWallet);
        token.transfer(admins[0], 1e18);

        assertEq(token.balanceOf(admins[0]), 1e18, "fee wallet pays no fee on the way out");
        assertEq(token.balanceOf(feeWallet), 0);
    }

    function test_RotationRequiresEmptyWallet() public {
        vm.prank(alice);
        token.transfer(bob, 100e18);

        vm.prank(admins[0]);
        vm.expectRevert(
            abi.encodeWithSelector(Loveriver.FeeWalletNotEmpty.selector, feeWallet, 1e18)
        );
        token.rotateFeeWallet(newFeeWallet);

        vm.prank(admins[0]);
        token.claimFeeWallet(admins[1]);
        assertEq(token.balanceOf(feeWallet), 0);

        vm.prank(admins[0]);
        token.rotateFeeWallet(newFeeWallet);
        assertEq(uint256(uint160(token.feeWallet())), uint256(uint160(newFeeWallet)), "fee wallet rotated");
    }

    function test_BurnFeesReducesSupply() public {
        vm.prank(alice);
        token.transfer(bob, 100e18);

        uint256 supplyBefore = token.totalSupply();
        vm.prank(admins[0]);
        uint256 burned = token.burnFees();

        assertEq(burned, 1e18);
        assertEq(token.totalSupply(), supplyBefore - 1e18, "burning is the only thing that cuts supply");
        assertEq(token.balanceOf(feeWallet), 0);
    }

    function test_RotatingAloneDoesNotReduceSupply() public {
        vm.prank(alice);
        token.transfer(bob, 100e18);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(admins[0]);
        token.claimFeeWallet(admins[2]);
        vm.prank(admins[0]);
        token.rotateFeeWallet(newFeeWallet);

        assertEq(token.totalSupply(), supplyBefore, "moving fees is not burning them");
    }

    function test_DistributeRangeFillsASliceExactly() public {
        address[] memory wallets = new address[](6);
        uint256 perWallet = 1000e18;
        for (uint256 i = 0; i < wallets.length; i++) {
            wallets[i] = address(uint160(0x1000 + i));
        }

        // Distribution pays out of the distributor's own balance; fund it first.
        vm.prank(owner);
        token.mint(admins[0], perWallet * wallets.length);

        vm.prank(admins[0]);
        token.distributeRange(wallets, perWallet, 0, 3);
        vm.prank(admins[0]);
        token.distributeRange(wallets, perWallet, 3, 6);

        for (uint256 i = 0; i < wallets.length; i++) {
            assertEq(token.balanceOf(wallets[i]), perWallet);
        }
        assertEq(token.balanceOf(feeWallet), 0, "distribution is not a trade and charges no fee");
    }

    function test_DistributeRangeRejectsBadBounds() public {
        address[] memory wallets = new address[](3);
        vm.prank(admins[0]);
        vm.expectRevert(abi.encodeWithSelector(Loveriver.RangeOutOfBounds.selector, 2, 9, 3));
        token.distributeRange(wallets, 1e18, 2, 9);
    }

    function test_NonAdminCannotTouchFeeSettings() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Loveriver.NotAdmin.selector, alice));
        token.setFeeBps(1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Loveriver.NotAdmin.selector, alice));
        token.rotateFeeWallet(newFeeWallet);
    }

    function test_FeeBpsCannotExceedCeiling() public {
        vm.prank(admins[0]);
        vm.expectRevert(abi.encodeWithSelector(Loveriver.FeeTooHigh.selector, 501, 500));
        token.setFeeBps(501);
    }

    function testFuzz_TransferNeverCreatesValue(uint256 amount, uint256 bps) public {
        bps = bound(bps, 0, 500);
        amount = bound(amount, 0, token.balanceOf(alice));

        vm.prank(admins[0]);
        token.setFeeBps(bps);

        uint256 supplyBefore = token.totalSupply();
        uint256 sumBefore = token.balanceOf(alice) + token.balanceOf(bob) + token.balanceOf(feeWallet);

        vm.prank(alice);
        token.transfer(bob, amount);

        uint256 sumAfter = token.balanceOf(alice) + token.balanceOf(bob) + token.balanceOf(feeWallet);
        assertEq(sumAfter, sumBefore, "a transfer conserves tokens");
        assertEq(token.totalSupply(), supplyBefore, "a transfer changes no supply");
    }
}
