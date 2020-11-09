/* solhint-disable no-inline-assembly */
// SPDX-License-Identifier:MIT
pragma solidity ^0.6.2;

library RSKAddrCompatibility {

    address constant public ZERO_PK_ADDR = 0xdcc703c0E500B653Ca82273B7BFAd8045D85a470;

    /*
    * @param addr it is an address to check that it does not originates from 
    * signing with PK = ZERO. RSK has a small difference in which @ZERO_PK_ADDR is 
    * also an address from PK = ZERO. So we check for both of them.
    */
    function checkPKNotZero(address addr) external returns (bool){
        if (addr == address(0) || addr == ZERO_PK_ADDR) {
            return false;
        }
        return true;
    }
}