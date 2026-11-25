// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy, Deployer} from "../script/Deploy.s.sol";
import {Loveriver, LVR_OPERATOR} from "../src/Loveriver.sol";

/**
 * Tests the deploy script.
 *
 * Almost everything here calls `Deployer.deploy(...)` directly, passing the owner, admins,
 * fee wallet, fee bps and supply as arguments. No environment variables are involved, so
 * the tests are independent and can run in parallel like any others. Exactly one test,
 * `test_RunReadsTheEnvironment`, goes through `run()`: that is the only place the
 * environment is read, so it is the only place that needs to be checked against it.
 */
contract DeployTest is Test {
    address constant ADMIN_1 = address(0xA11CE);
    address constant ADMIN_2 = address(0xB0B);
    address constant ADMIN_3 = address(0xCA401);
    address constant ADMIN_4 = address(0xD00D);
    address constant ADMIN_5 = address(0xE1E1);
    address constant FEE_WALLET = address(0xFEE);
    address constant NEW_FEE_WALLET = address(0x9E1);
    address constant NOT_AN_ADMIN = address(0xDEAD);
    address constant RECIPIENT = address(0x1234);

    /// A wallet whose only ever income is a distribution, used to check that receiving
    /// tokens grants nothing.
    address constant DISTRIBUTED_WALLET = address(0x5A1E5);

    function adminSet() internal pure returns (address[5] memory admins) {
        admins[0] = ADMIN_1;
        admins[1] = ADMIN_2;
        admins[2] = ADMIN_3;
        admins[3] = ADMIN_4;
        admins[4] = ADMIN_5;
    }

    function oneAddress(address who) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = who;
    }

    function test_DeployConfiguresTheToken() public {
        Loveriver token = Deployer.deploy(address(this), adminSet(), FEE_WALLET, 100, 699_999_999_999 ether);

        assertEq(uint256(uint160(token.owner())), uint256(uint160(address(this))), "owner");

        assertTrue(token.isAdmin(ADMIN_1), "admin 1");
        assertTrue(token.isAdmin(ADMIN_2), "admin 2");
        assertTrue(token.isAdmin(ADMIN_3), "admin 3");
        assertTrue(token.isAdmin(ADMIN_4), "admin 4");
        assertTrue(token.isAdmin(ADMIN_5), "admin 5");
        assertFalse(token.isAdmin(NOT_AN_ADMIN), "an unconfigured address must not be an admin");

        assertEq(uint256(uint160(token.feeWallet())), uint256(uint160(FEE_WALLET)), "fee wallet");
        assertEq(token.feeBps(), 100, "fee bps");

        uint256 expected = 699_999_999_999 ether;
        assertEq(token.totalSupply(), expected, "total supply");
        assertEq(token.balanceOf(address(this)), expected, "the owner holds the whole initial supply");
    }

    /// The optional destination: supply to someone other than the owner, owner unchanged.
    function test_DeployMintsToTheWalletItIsGiven() public {
        Loveriver token = Deployer.deploy(address(this), adminSet(), FEE_WALLET, 100, 5000 ether, ADMIN_2);

        assertEq(token.balanceOf(ADMIN_2), 5000 ether, "supply minted to the named wallet");
        assertEq(token.balanceOf(address(this)), 0, "the owner receives nothing when a destination is given");
        assertEq(
            uint256(uint160(token.owner())),
            uint256(uint160(address(this))),
            "minting elsewhere must not move ownership"
        );

        // The reason for the option: that wallet can distribute straight away.
        vm.prank(ADMIN_2);
        token.distributeRange(oneAddress(RECIPIENT), 1 ether, 0, 1);
        assertEq(token.balanceOf(RECIPIENT), 1 ether, "the funded admin can distribute immediately");
    }

    function test_DeployedTokenIsUsable() public {
        Loveriver token = Deployer.deploy(address(this), adminSet(), FEE_WALLET, 100, 1000 ether);

        token.mint(RECIPIENT, 5 ether);
        assertEq(token.balanceOf(RECIPIENT), 5 ether, "the owner can still mint");

        // Distribution pays out of the distributor's own balance, so fund it first.
        token.mint(ADMIN_3, 2 ether);

        vm.prank(ADMIN_3);
        token.distributeRange(oneAddress(RECIPIENT), 1 ether, 0, 1);
        assertEq(token.balanceOf(RECIPIENT), 6 ether, "a configured admin can distribute");

        vm.prank(ADMIN_3);
        token.distributeRange(oneAddress(DISTRIBUTED_WALLET), 0.5 ether, 0, 1);
        assertEq(token.balanceOf(DISTRIBUTED_WALLET), 0.5 ether, "a distribution wallet is funded");

        // Holding tokens is not holding a role. Every admin-only action must refuse this
        // wallet, not merely report isAdmin() as false.
        bytes memory notAdmin = abi.encodeWithSelector(Loveriver.NotAdmin.selector, DISTRIBUTED_WALLET);

        vm.prank(DISTRIBUTED_WALLET);
        vm.expectRevert(notAdmin);
        token.setFeeBps(1);

        vm.prank(DISTRIBUTED_WALLET);
        vm.expectRevert(notAdmin);
        token.rotateFeeWallet(DISTRIBUTED_WALLET);

        vm.prank(DISTRIBUTED_WALLET);
        vm.expectRevert(notAdmin);
        token.burnFees();

        vm.prank(DISTRIBUTED_WALLET);
        vm.expectRevert(notAdmin);
        token.distributeRange(oneAddress(RECIPIENT), 0.1 ether, 0, 1);

        vm.prank(DISTRIBUTED_WALLET);
        vm.expectRevert(abi.encodeWithSelector(Loveriver.NotOwner.selector, DISTRIBUTED_WALLET));
        token.mint(DISTRIBUTED_WALLET, 1 ether);

        // Rotation straight after deployment: the fee wallet starts empty, so the rule
        // that it must be empty before rotating is satisfied with no claim step first.
        assertEq(token.balanceOf(FEE_WALLET), 0, "the fee wallet starts empty");

        vm.prank(ADMIN_3);
        token.rotateFeeWallet(NEW_FEE_WALLET);
        assertEq(
            uint256(uint160(token.feeWallet())),
            uint256(uint160(NEW_FEE_WALLET)),
            "an admin can rotate the fee wallet before any fees have accrued"
        );

        // And the rotation is real: the next trade pays the new wallet, not the old one.
        vm.prank(DISTRIBUTED_WALLET);
        token.transfer(RECIPIENT, 0.5 ether);

        assertEq(token.balanceOf(NEW_FEE_WALLET), 0.005 ether, "the new fee wallet collects the fee");
        assertEq(token.balanceOf(FEE_WALLET), 0, "the replaced fee wallet receives nothing");
        assertEq(token.balanceOf(RECIPIENT), 6.495 ether, "the recipient gets the amount minus the fee");
    }

    /// Who holds authority is no longer read from the environment: the owner, every admin slot
    /// and the fee wallet are LVR_OPERATOR. What `run()` still has to get right is that it
    /// grants all of them to that one address and reads only the policy knobs outward.
    function test_RunGrantsEveryRoleToTheOperator() public {
        address op = LVR_OPERATOR;
        // Named here on purpose: these are the variables that used to pick the roles, and the
        // set of them that still works is exactly the set that names the operator.
        vm.setEnv("OWNER", vm.toString(op));
        vm.setEnv("FEE_WALLET", vm.toString(op));
        vm.setEnv("ADMIN_1", vm.toString(op));
        vm.setEnv("ADMIN_2", vm.toString(op));
        vm.setEnv("ADMIN_3", vm.toString(op));
        vm.setEnv("ADMIN_4", vm.toString(op));
        vm.setEnv("ADMIN_5", vm.toString(op));
        vm.setEnv("FEE_BPS", "250");
        vm.setEnv("INITIAL_SUPPLY", "1000");

        Loveriver token = new Deploy().run();

        assertEq(uint256(uint160(token.owner())), uint256(uint160(op)), "the operator owns the token");
        assertEq(uint256(uint160(token.feeWallet())), uint256(uint160(op)), "the operator collects the fees");
        assertTrue(token.isAdmin(op), "the operator is an administrator, from any slot");
        assertEq(token.feeBps(), 250, "FEE_BPS is still read from the environment");
        assertEq(token.totalSupply(), 1000 ether, "INITIAL_SUPPLY is still read from the environment");
        assertEq(token.balanceOf(op), 1000 ether, "by default the supply lands on the operator");
    }

    /// A role variable naming somebody else is refused, and the sentence says which variable.
    /// Checked through the pure rule rather than through the environment: forge shares
    /// `vm.setEnv` across tests and runs them in parallel, so a test that sets ADMIN_1 to a
    /// foreign address is a race with every other test in this file.
    function test_RoleRefusalNamesTheForeignVariable() public {
        Deploy deployer = new Deploy();

        assertEq(deployer.roleRefusal("ADMIN_1", ADMIN_1), "ADMIN_1 names an address that is not LVR_OPERATOR; roles are fixed in the token, not in the environment");
        assertEq(deployer.roleRefusal("OWNER", ADMIN_2), "OWNER names an address that is not LVR_OPERATOR; roles are fixed in the token, not in the environment");
        assertEq(
            deployer.roleRefusal("FEE_WALLET", address(0)),
            "FEE_WALLET names an address that is not LVR_OPERATOR; roles are fixed in the token, not in the environment"
        );
    }

    /// And the operator itself is accepted, which is what makes the check a check rather than a
    /// refusal of everything.
    function test_RoleRefusalAcceptsTheOperator() public {
        Deploy deployer = new Deploy();

        assertEq(deployer.roleRefusal("ADMIN_1", LVR_OPERATOR), "");
        assertEq(deployer.roleRefusal("OWNER", LVR_OPERATOR), "");
    }
}
