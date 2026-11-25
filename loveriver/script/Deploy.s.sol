// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {
    Loveriver,
    LVR_OPERATOR,
    LVR_FEE_WALLET,
    LVR_ADMIN_1,
    LVR_ADMIN_2,
    LVR_ADMIN_3,
    LVR_ADMIN_4,
    LVR_ADMIN_5
} from "../src/Loveriver.sol";

/**
 * Deploys Loveriver and mints the initial supply, in one broadcast.
 *
 * The work is done by `Deployer.deploy(...)`, which takes everything it needs as
 * arguments: no environment, no broadcast, no cheatcodes. That is the part worth testing,
 * so tests call it directly instead of writing process-wide environment variables and
 * racing each other. `run()` is only the wrapper that reads the environment, names the
 * broadcasting account and calls it.
 *
 * WHO HOLDS AUTHORITY IS NOT AN ENVIRONMENT VARIABLE
 *
 * The roles are fixed in the token's source, and they are three separate sets of keys:
 *
 *   owner       LVR_OPERATOR                the mint authority
 *   fee wallet  LVR_FEE_WALLET              where fees accrue
 *   admins      LVR_ADMIN_1 .. LVR_ADMIN_5   distribution, fee and rotation rights
 *
 * Nothing here reads a role from the environment, and a role variable that names a different
 * address is refused rather than ignored - a deploy that quietly disregarded a name the
 * caller typed is worse than one that stops. Each variable is refused against the constant
 * for its own role, so setting ADMIN_1 to the operator is an error, not a coincidence.
 *
 * The consequence is that the deploy must be signed by the operator key: mint() is owner-only
 * and the initial supply is minted in this same broadcast, so a key that is not the
 * operator's cannot complete it. The roles can still be re-delegated afterwards with
 * transferOwnership() and setAdmin().
 *
 * Optional environment:
 *   MINT_TO              where the initial supply lands (default: the operator). Set it to
 *                        the distributing admin so the funder can run immediately
 *                        after the deploy, with no manual transfer in between.
 *   FEE_BPS              fee in basis points (default 100 = 1%)
 *   INITIAL_SUPPLY       whole LVR minted (default 699999999999)
 *
 * Refused if set to anything but the operator: OWNER, FEE_WALLET, ADMIN_1 .. ADMIN_5.
 *
 * Example, against a local chain only:
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url http://127.0.0.1:8545 --private-key $OPERATOR_KEY --broadcast
 *
 * Leave off --broadcast to simulate: the script runs, nothing is sent anywhere.
 *
 * After a broadcast, record it: `node tools/record-deployment.mjs` reads the artifact Forge
 * just wrote under broadcast/Deploy.s.sol/<chain>/ and puts the chain id, token address,
 * deploy block and owner into deployments.json - the file the audit, top-up and funder read.
 * Nothing is copied out of this output by hand, and `--check` exits 1 when the file no longer
 * matches the latest broadcast, which is what a redeploy leaves behind if nobody records it.
 */
/**
 * The deploy logic, as plain internal functions.
 *
 * Internal is the point, not a detail: `mint()` is owner-only, and an internal call runs
 * in the caller's frame, so the mint is executed by whoever called this - the
 * broadcasting account during a script run, the test contract during a test. Put the same
 * code on a contract and `msg.sender` for the mint becomes that contract's own address,
 * which is not the owner, and the deploy reverts.
 */
library Deployer {
    /// Deploys the token and mints `initialSupply` to `owner`.
    function deploy(
        address owner,
        address[5] memory admins,
        address feeWallet,
        uint256 feeBps,
        uint256 initialSupply
    ) internal returns (Loveriver token) {
        return deploy(owner, admins, feeWallet, feeBps, initialSupply, owner);
    }

    /// Same, with the supply going to a wallet other than the owner. The owner keeps the
    /// mint authority either way; only where the tokens land changes.
    function deploy(
        address owner,
        address[5] memory admins,
        address feeWallet,
        uint256 feeBps,
        uint256 initialSupply,
        address mintTo
    ) internal returns (Loveriver token) {
        token = new Loveriver(owner, admins, feeWallet, feeBps);
        token.mint(mintTo, initialSupply);
    }
}

contract Deploy is Script {
    /// The refusal rule, as a pure function: empty when the address a role variable named is
    /// the operator, otherwise the sentence the deploy stops with.
    ///
    /// Separated from the environment read on purpose. `vm.setEnv` changes process state that
    /// forge shares across tests and runs tests in parallel, so two tests that set different
    /// ADMIN_1 values race. Pinning the rule here keeps the test honest and independent.
    /// `expectedName` is the constant the role is fixed to, so the sentence says which role the
    /// address failed rather than naming one address for every role.
    function roleRefusal(
        string memory name,
        address named,
        string memory expectedName,
        address expected
    ) public pure returns (string memory) {
        if (named == expected) return "";
        return
            string.concat(
                name,
                " names an address that is not ",
                expectedName,
                "; roles are fixed in the token, not in the environment"
            );
    }

    /// A role variable set to anything but the address the token fixes for that role stops the
    /// deploy. Ignoring it would leave the caller believing a wallet they named holds a role it
    /// does not have.
    function _refuse(string memory name, string memory expectedName, address expected) private view {
        string memory refusal = roleRefusal(name, vm.envOr(name, expected), expectedName, expected);
        require(bytes(refusal).length == 0, refusal);
    }

    function run() external returns (Loveriver token) {
        address op = LVR_OPERATOR;
        address feeWallet = LVR_FEE_WALLET;
        address[5] memory admins = [LVR_ADMIN_1, LVR_ADMIN_2, LVR_ADMIN_3, LVR_ADMIN_4, LVR_ADMIN_5];

        _refuse("OWNER", "LVR_OPERATOR", op);
        _refuse("FEE_WALLET", "LVR_FEE_WALLET", feeWallet);
        _refuse("ADMIN_1", "LVR_ADMIN_1", admins[0]);
        _refuse("ADMIN_2", "LVR_ADMIN_2", admins[1]);
        _refuse("ADMIN_3", "LVR_ADMIN_3", admins[2]);
        _refuse("ADMIN_4", "LVR_ADMIN_4", admins[3]);
        _refuse("ADMIN_5", "LVR_ADMIN_5", admins[4]);

        uint256 feeBps = vm.envOr("FEE_BPS", uint256(100));
        uint256 initialSupply = vm.envOr("INITIAL_SUPPLY", uint256(699_999_999_999)) * 1e18;

        // Ownership and the initial supply are separate decisions: the operator keeps the
        // mint authority, while the supply can land directly on the admin the funder will
        // use, so distribution needs no manual transfer first.
        address mintTo = vm.envOr("MINT_TO", op);

        // Broadcast as the operator, not as whatever key happens to be loaded: the mint below
        // is owner-only, and the owner is the constant. A foreign key fails to sign here
        // instead of deploying a token it cannot finish setting up.
        vm.startBroadcast(op);
        token = Deployer.deploy(op, admins, feeWallet, feeBps, initialSupply, mintTo);
        vm.stopBroadcast();

        console.log("Loveriver deployed at", address(token));
        console.log("  operator   ", op);
        console.log("  owner      ", op);
        console.log("  fee wallet ", feeWallet);
        console.log("  fee bps    ", feeBps);
        console.log("  minted     ", initialSupply);
        console.log("  minted to  ", mintTo);
        console.log("  totalSupply", token.totalSupply());
        for (uint256 i = 0; i < admins.length; i++) {
            console.log("  admin      ", admins[i]);
        }

        // Printed, not written: a broadcast should not edit a committed file.
        console.log("\nRecord this deploy: node tools/record-deployment.mjs");
    }
}
