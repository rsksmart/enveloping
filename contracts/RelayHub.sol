/* solhint-disable avoid-low-level-calls */
/* solhint-disable no-inline-assembly */
/* solhint-disable not-rely-on-time */
/* solhint-disable avoid-tx-origin */
/* solhint-disable bracket-align */
// SPDX-License-Identifier:MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "./utils/MinLibBytes.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "./utils/GsnEip712Library.sol";
import "./interfaces/GsnTypes.sol";
import "./interfaces/IRelayHub.sol";
import "./interfaces/IForwarder.sol";
import "./interfaces/IStakeManager.sol";
 
contract RelayHub is IRelayHub {
    using SafeMath for uint256;

    uint256 public override minimumStake;
    uint256 public override minimumUnstakeDelay;
    uint256 public override maximumRecipientDeposit;
    uint256 public override gasOverhead;
    uint256 public override maxWorkerCount;
    address override public penalizer;
    address override public stakeManager;
    string public override versionHub = "2.0.1+opengsn.hub.irelayhub";

    // maps relay worker's address to its manager's address
    mapping(address => bytes32) public override workerToManager;

    // maps relay managers to the number of their workers
    mapping(address => uint256) public override workerCount;

    constructor (
        address _stakeManager,
        address _penalizer,
        uint256 _maxWorkerCount,
        uint256 _gasOverhead,
        uint256 _maximumRecipientDeposit,
        uint256 _minimumUnstakeDelay,
        uint256 _minimumStake
    ) public {
        stakeManager = _stakeManager;
        penalizer = _penalizer;
        maxWorkerCount = _maxWorkerCount;
        gasOverhead = _gasOverhead;
        maximumRecipientDeposit = _maximumRecipientDeposit;
        minimumUnstakeDelay = _minimumUnstakeDelay;
        minimumStake =  _minimumStake;
    }

    function registerRelayServer(uint256 baseRelayFee, uint256 pctRelayFee, string calldata url) external override {
        //relay manager is msg.sender
        //Check if Relay Manager is staked
        /* solhint-disable-next-line avoid-low-level-calls */
        (bool succ,) = stakeManager.call(abi.encodeWithSelector(IStakeManager.requireManagerStaked.selector,
                msg.sender,minimumStake,minimumUnstakeDelay));
        require(succ, "relay manager not staked" );

        require(workerCount[msg.sender] > 0, "no relay workers");
        emit RelayServerRegistered(msg.sender, baseRelayFee, pctRelayFee, url);
    }


    function disableRelayWorkers(address[] calldata relayWorkers) external override {
        //relay manager is msg.sender
        uint256 actualWorkerCount = workerCount[msg.sender];
        require(actualWorkerCount >= relayWorkers.length, "invalid quantity of workers");
        workerCount[msg.sender] = actualWorkerCount - relayWorkers.length;
        
        //Check if Relay Manager is staked
        /* solhint-disable-next-line avoid-low-level-calls */
        (bool succ,) = stakeManager.call(abi.encodeWithSelector(IStakeManager.requireManagerStaked.selector,
                msg.sender,minimumStake,minimumUnstakeDelay));
        require(succ, "relay manager not staked" );


        bytes32 enabledWorker = bytes32(uint256(msg.sender) << 4) | 0x0000000000000000000000000000000000000000000000000000000000000001;
        bytes32 disabledWorker = bytes32(uint256(msg.sender) << 4);
        
        for (uint256 i = 0; i < relayWorkers.length; i++) {
            //The relay manager can only disable its relay workers and only if they are enabled (right-most nibble as 1)
            require(workerToManager[relayWorkers[i]] == enabledWorker, "Incorrect Manager");
            //Disabling a worker means putting the right-most nibble to 0
            workerToManager[relayWorkers[i]] = disabledWorker;
        }

        emit RelayWorkersDisabled(msg.sender, relayWorkers, workerCount[msg.sender]);
    }

    /**
    New relay worker addresses can be added (as enabled workers) as long as they don't have a relay manager aldeady assigned.
     */
    function addRelayWorkers(address[] calldata newRelayWorkers) external override {
        address relayManager = msg.sender;
        workerCount[relayManager] = workerCount[relayManager] + newRelayWorkers.length;
        require(workerCount[relayManager] <= maxWorkerCount, "too many workers");

        //Check if Relay Manager is staked
        /* solhint-disable-next-line avoid-low-level-calls */
        (bool succ,) = stakeManager.call(abi.encodeWithSelector(IStakeManager.requireManagerStaked.selector,
                relayManager,minimumStake,minimumUnstakeDelay));
        require(succ, "relay manager not staked" );

        bytes32 enabledWorker = bytes32(uint256(relayManager) << 4) | 0x0000000000000000000000000000000000000000000000000000000000000001;
        for (uint256 i = 0; i < newRelayWorkers.length; i++) {
            require(workerToManager[newRelayWorkers[i]] == bytes32(0), "this worker has a manager");
            workerToManager[newRelayWorkers[i]] = enabledWorker;
        }

        emit RelayWorkersAdded(relayManager, newRelayWorkers, workerCount[relayManager]);
    }

 function deployCall(
        GsnTypes.DeployRequest calldata deployRequest,
        bytes calldata signature    )
    external
    override
    {
        (signature);
        
        bytes32 managerEntry = workerToManager[msg.sender];

        //read last nibble which stores the isWorkerEnabled flag, it must be 1 (true)
        require(managerEntry & 0x0000000000000000000000000000000000000000000000000000000000000001 
        == 0x0000000000000000000000000000000000000000000000000000000000000001, "Not an enabled worker");

        address manager = address(uint160(uint256(managerEntry >> 4)));

        require(gasleft() >= gasOverhead.add(deployRequest.request.gas), "Not enough gas left");
        require(msg.sender == tx.origin, "RelayWorker cannot be a contract");
        require(msg.sender == deployRequest.relayData.relayWorker, "Not a right worker");

         /* solhint-disable-next-line avoid-low-level-calls */
        (bool succ,) = stakeManager.call(abi.encodeWithSelector(IStakeManager.requireManagerStaked.selector,
                manager,minimumStake,minimumUnstakeDelay));
        require(succ, "relay manager not staked" );
        require(deployRequest.relayData.gasPrice <= tx.gasprice, "Invalid gas price");
      
        
        bool deploySuccess = GsnEip712Library.deploy(deployRequest, signature);          
        
        if ( !deploySuccess ) {
            assembly {
                revert(0, 0)
            }
        }
    }


function batchRelayCall(
        GsnTypes.RelayRequest[] calldata relayRequests,
        bytes[] calldata signatures) external 
    
    {
        (signatures);
        
        require(relayRequests.length == signatures.length, "Invalid num of params");
        require(msg.sender == tx.origin, "RelayWorker cannot be a contract");

        uint256 totalGas;
        for(uint256 i = 0; i< relayRequests.length; i++){
            require(msg.sender == relayRequests[i].relayData.relayWorker, "Not a right worker");
            require(relayRequests[i].relayData.gasPrice <= tx.gasprice, "Invalid gas price");

            totalGas = totalGas.add(relayRequests[i].request.gas);
        }

        require(gasleft() >= gasOverhead.add(totalGas), "Not enough gas left");

        bytes32 managerEntry = workerToManager[msg.sender];
        //read last nibble which stores the isWorkerEnabled flag, it must be 1 (true)
         require(managerEntry & 0x0000000000000000000000000000000000000000000000000000000000000001 
        == 0x0000000000000000000000000000000000000000000000000000000000000001, "Not an enabled worker");

        address manager = address(uint160(uint256(managerEntry >> 4)));

         /* solhint-disable-next-line avoid-low-level-calls */
        (bool succ,) = stakeManager.call(abi.encodeWithSelector(hex"fe716339",   //fe716339  =>  requireManagerStaked(address,uint256,uint256)
                manager,minimumStake,minimumUnstakeDelay));
        require(succ, "relay manager not staked" );
    
        //use succ as relay call success variabl

        for(uint256 i = 0; i< relayRequests.length; i++){
            /* solhint-disable-next-line avoid-low-level-calls */
            (bool success, bytes memory ret) = relayRequests[i].relayData.callForwarder.call(
                abi.encodeWithSelector(IForwarder.execute.selector, relayRequests[i].relayData.domainSeparator,
                GsnEip712Library.hashRelayData(relayRequests[i].relayData), relayRequests[i].request, signatures[i]
                ));
            
            if (success) {
                (success, ret) = abi.decode(ret, (bool, bytes)); // decode return value of execute:
                MinLibBytes.truncateInPlace(ret, 1024); // maximum length of return value/revert reason for 'execute' method. Will truncate result if exceeded.

                if (success) {
                    emit TransactionRelayed(
                        manager,
                        tx.origin,
                        keccak256(signatures[i]),
                        ret
                    );
                }
                else{
                    emit TransactionRelayedButRevertedByRecipient(            
                        manager,
                        tx.origin,
                        keccak256(signatures[i]),
                        ret
                    );
                }

            }
            else{
                MinLibBytes.truncateInPlace(ret, 1024); // maximum length of return value/revert reason for 'execute' method. Will truncate result if exceeded.

                emit TransactionFailed(
                    manager,
                    tx.origin,
                    keccak256(signatures[i]),
                    ret
                );
            }

        }     

    }


    function relayCall(
        GsnTypes.RelayRequest calldata relayRequest,
        bytes calldata signature) 
    external override
    {
        (signature);
        
        require(gasleft() >= gasOverhead.add(relayRequest.request.gas), "Not enough gas left");
        require(msg.sender == tx.origin, "RelayWorker cannot be a contract");
        require(msg.sender == relayRequest.relayData.relayWorker, "Not a right worker");
        require(relayRequest.relayData.gasPrice <= tx.gasprice, "Invalid gas price");

        bytes32 managerEntry = workerToManager[msg.sender];
        //read last nibble which stores the isWorkerEnabled flag, it must be 1 (true)
         require(managerEntry & 0x0000000000000000000000000000000000000000000000000000000000000001 
        == 0x0000000000000000000000000000000000000000000000000000000000000001, "Not an enabled worker");

        address manager = address(uint160(uint256(managerEntry >> 4)));

         /* solhint-disable-next-line avoid-low-level-calls */
        (bool succ,) = stakeManager.call(abi.encodeWithSelector(hex"fe716339",   //fe716339  =>  requireManagerStaked(address,uint256,uint256)
                manager,minimumStake,minimumUnstakeDelay));
        require(succ, "relay manager not staked" );
      
        bool forwarderSuccess;
        bytes memory relayedCallReturnValue;
        //use succ as relay call success variable
        (forwarderSuccess, succ, relayedCallReturnValue) = GsnEip712Library.execute(relayRequest, signature);          
        
        if ( !forwarderSuccess ) {
            assembly {
                revert(add(relayedCallReturnValue, 32), mload(relayedCallReturnValue))
            }
        }
       
       if (succ) {
                emit TransactionRelayed(
                    manager,
                    msg.sender,
                    keccak256(signature),
                    relayedCallReturnValue
                );
        }
        else{

           emit TransactionRelayedButRevertedByRecipient(            
            manager,
            msg.sender,
            keccak256(signature),
            relayedCallReturnValue);
        }
    }

    function isRelayManagerStaked(address relayManager) public override returns (bool){
        /* solhint-disable-next-line avoid-low-level-calls */
        (bool succ,) = stakeManager.call(abi.encodeWithSelector(IStakeManager.requireManagerStaked.selector,
                relayManager,minimumStake,minimumUnstakeDelay));
        
        //If no revert, then return true
        require(succ, "relay manager not staked");
        return true;
    }

    modifier penalizerOnly () {
        require(msg.sender == penalizer, "Not penalizer");
        _;
    }

    function penalize(address relayWorker, address payable beneficiary) external override penalizerOnly {
        //Relay worker might be enabled or disabled
        address relayManager = address(uint160(uint256(workerToManager[relayWorker] >> 4)));
        require(relayManager != address(0), "Unknown relay worker");

        require(
            isRelayManagerStaked(relayManager),
            "relay manager not staked"
        );
        IStakeManager.StakeInfo memory stakeInfo = IStakeManager(stakeManager).getStakeInfo(relayManager);
        IStakeManager(stakeManager).penalizeRelayManager(relayManager, beneficiary, stakeInfo.stake);
    }

 
}
