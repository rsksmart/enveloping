// SPDX-License-Identifier:MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "../interfaces/EnvelopingTypes.sol";
import "../interfaces/IForwarder.sol";
import "../interfaces/IWalletFactory.sol";
import "./MinLibBytes.sol";
/**
 * Bridge Library to map Enveloping RelayRequest into a call of a SmartWallet
 */
library Eip712Library {
    function deploy(EnvelopingTypes.DeployRequest calldata relayRequest, bytes calldata signature) internal returns (bool deploySuccess, bytes memory ret) {

            // The gas limit for the deploy creation is injected here, since the gasCalculation
            // estimate is done against the whole relayedUserSmartWalletCreation function in
            // the relayClient

            /* solhint-disable-next-line avoid-low-level-calls */
            (deploySuccess, ret) = relayRequest.relayData.callForwarder.call(
                abi.encodeWithSelector(IWalletFactory.relayedUserSmartWalletCreation.selector,
                relayRequest.request, relayRequest.relayData.domainSeparator, 
                hashRelayData(relayRequest.relayData), signature
            ));
 
    }

    //forwarderSuccess = Did the call to IForwarder.execute() revert or not?
    //relaySuccess = Did the destination-contract call revert or not?
    //ret = if !forwarderSuccess it is the revert reason of IForwarder, otherwise it is the destination-contract return data, wich might be
    // a revert reason if !relaySuccess
    function execute(EnvelopingTypes.RelayRequest calldata relayRequest, bytes calldata signature) internal returns (bool forwarderSuccess, bool relaySuccess, bytes memory ret) {
            /* solhint-disable-next-line avoid-low-level-calls */
            (forwarderSuccess, ret) = relayRequest.relayData.callForwarder.call(
                abi.encodeWithSelector(IForwarder.execute.selector, relayRequest.relayData.domainSeparator,
                hashRelayData(relayRequest.relayData), relayRequest.request, signature
                ));
            
            if ( forwarderSuccess ) {
                (relaySuccess, ret) = abi.decode(ret, (bool, bytes)); // decode return value of execute:
            }

            MinLibBytes.truncateInPlace(ret, 1024); // maximum length of return value/revert reason for 'execute' method. Will truncate result if exceeded.
    }

    function hashRelayData(EnvelopingTypes.RelayData calldata req) internal pure returns (bytes32) {
        return keccak256(abi.encode(
                keccak256("RelayData(uint256 gasPrice,bytes32 domainSeparator,address relayWorker,address callForwarder,address callVerifier)"), // RELAYDATA_TYPEHASH
                req.gasPrice,
                req.domainSeparator,
                req.relayWorker,
                req.callForwarder,
                req.callVerifier
            ));
    }
}
