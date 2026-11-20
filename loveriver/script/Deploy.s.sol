// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Loveriver} from "../src/Loveriver.sol";

/**
 * Deploys Loveriver and mints the initial supply, in one broadcast.
 *
 * The work is done by `Deployer.deploy(...)`, which takes everything it needs as
 * arguments: no environment, no broadcast, no cheatcodes. That is the part worth testing,
 * so tests call it directly instead of writing process-wide environment variables and
 * racing each other. `run()` is only the wrapper that reads the environment, names the
 * broadcasting account and calls it.
 *
 * The owner is the broadcasting account, because mint() is owner-only: taking the owner
 * from the same key that signs the transactions is what keeps the mint in the same run
 * as the deploy. Ownership can be moved afterwards with transferOwnership().
 *
 * Required environment:
 *   ADMIN_1 .. ADMIN_5   the five administrator wallets
 *   FEE_WALLET           the first fee collector, which must start empty
 *
 * Optional environment:
 *   OWNER                the mint authority and owner (default: the broadcast account)
 *   MINT_TO              where the initial supply lands (default: the owner). Set it to
 *                        the distributing admin so the funder can run immediately
 *                        after the deploy, with no manual transfer in between.
 *   FEE_BPS              fee in basis points (default 100 = 1%)
 *   INITIAL_SUPPLY       whole LVR minted (default 699999999999)
 *
 * Example, against a local chain only:
 *   ADMIN_1=0x... ADMIN_2=0x... ADMIN_3=0x... ADMIN_4=0x... ADMIN_5=0x... \
 *   FEE_WALLET=0x... forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url http://127.0.0.1:8545 --private-key $KEY --broadcast
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
    function run() external returns (Loveriver token) {
        address[5] memory admins = [
            vm.envAddress("ADMIN_1"),
            vm.envAddress("ADMIN_2"),
            vm.envAddress("ADMIN_3"),
            vm.envAddress("ADMIN_4"),
            vm.envAddress("ADMIN_5")
        ];
        address feeWallet = vm.envAddress("FEE_WALLET");
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(100));
        uint256 initialSupply = vm.envOr("INITIAL_SUPPLY", uint256(699_999_999_999)) * 1e18;

        // The account that signs is the owner, because mint() is owner-only. It is named
        // explicitly in the broadcast rather than inferred: a script's msg.sender and the
        // account its calls execute as are not the same thing under a test harness, and
        // inferring one from the other silently deploys a token nobody can mint.
        address owner = vm.envOr("OWNER", msg.sender);

        // Ownership and the initial supply are separate decisions: the owner keeps the
        // mint authority, while the supply can land directly on the admin the funder
        // will use, so distribution needs no manual transfer first.
        address mintTo = vm.envOr("MINT_TO", owner);

        vm.startBroadcast(owner);
        token = Deployer.deploy(owner, admins, feeWallet, feeBps, initialSupply, mintTo);
        vm.stopBroadcast();

        console.log("Loveriver deployed at", address(token));
        console.log("  owner      ", owner);
        console.log("  fee wallet ", feeWallet);
        console.log("  fee bps    ", feeBps);
        console.log("  minted     ", initialSupply);
        console.log("  minted to  ", mintTo);
        console.log("  totalSupply", token.totalSupply());
        for (uint256 i = 0; i < admins.length; i++) {
            console.log("  admin      ", admins[i]);
        }

        // The record is not written from here: a script editing the repository's committed file
        // is not something to do mid-broadcast. The one command below reads the broadcast that
        // was just written - chain id, address, block, signer - so nothing is retyped.
        console.log("");
        console.log("Record this deploy: node tools/record-deployment.mjs");
    }
}
