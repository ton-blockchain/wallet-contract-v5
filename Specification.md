# Extensible Wallet V5

Author: Oleg Andreev <oleg@tonkeeper.com>

This is an extensible wallet specification aimed at replacing V4 and allowing arbitrary extensions.

* [Features](#features)
* [Overview](#overview)
* [Discussion](#discussion)
* [TL-B definitions](#tl-b-definitions)
* [Source code](#source-code)


## Credits

Thanks to [Andrew Gutarev](https://github.com/pyAndr3w) for the idea to set c5 register to a [list of pre-composed actions](https://github.com/pyAndr3w/ton-preprocessed-wallet-v2).

Thanks to [@subden](https://t.me/subden), [@botpult](https://t.me/botpult) and [@tvorogme](https://t.me/tvorogme) for ideas and discussion.

Thanks to [Skydev](https://github.com/Skydev0h) for optimization and preparing the second revision of the contract.


## Features

* 25% smaller computation fees.
* Arbitrary amount of outgoing messages is supported via action list.
* Wallet code can be extended by anyone in a decentralized and conflict-free way: multiple feature extensions can co-exist.
* Extensions can perform the same operations as the signer: emit arbitrary messages on behalf of the owner, add and remove extensions.
* Signed requests can be delivered via internal message to allow 3rd party pay for gas.
* For consistency and ease of indexing, external messages also receive a 32-bit opcode.
* To lay foundation for support of scenarios like 2FA or access recovery it is possible to disable signature authentication by extension.

## Overview

Wallet V5 supports **2 authentication modes** and **3 operations types**.

Authentication:
* by signature
* by extension

Operations:
* standard "send message" action (up to 255 messages at once),
* enable/disable signature authentication (can be invoked only by extension),
* install/remove extension.

Signed messages can be delivered both by external and internal messages.

All operations are available to all authentication modes.

## Discussion

### What is the job of the wallet?

The job of the wallet is to send messages to other apps in the TON network on behalf of a single user identified by a single public key.
User may delegate this job to other apps via extensions.

### The wallet is not for:

* multi-user operation: you should use a multisig or DAO solution instead.
* routing of incoming payments and messages: use a specialized contract instead.
* imposing limits on access to certain assets: put account restriction inside a jetton, or use a lockup contract instead.

### Extending the wallet

The best way to extend functionality of the wallet is to use the extensions mechanism that permit delegating access to the wallet to other contracts.

From the perspective of the wallet, every extension can perform the same actions as the owner of a private key. Therefore limits and capabilities can be embedded in such an extension with a custom storage scheme.

Extensions can co-exist simultaneously, so experimental capabilities can be deployed and tested independently from each other.

### Can the wallet outsource payment for gas fees?

Yes! You can deliver signed messages via an internal message from a 3rd party wallet. Also, the message is handled exactly like an external one: after the basic checks the wallet takes care of the fees itself, so that 3rd party does not need to overpay for users who actually do have TONs.

### Can plugins implement subscriptions that collect tokens?

Yes. Plugins can emit arbitrary messages, including token transfers, on behalf of the wallet.

### How can a plugin collect funds?

Plugin needs to send a request with a message to its own address.

### How can a plugin self-destruct?

Plugin can self-destroy by sending all TONs to the wallet with sendmode 128 and adding one more action that removes itself from the list.

### How can I deploy a plugin, install its code and send it a message in one go?

You need to put two requests in your message body:
1. add the extension address,
2. send a message with stateinit to that address.

### Does the wallet grow with number of plugins?

Yes. We have considered constant-size schemes where the wallet only stores trusted extension code. However, extension authentication becomes combursome and expensive: plugin needs to transmit additional data and each request needs to recompute plugin’s address. We estimate that for the reasonably sized wallets (less than 100 plugins) authentication via the dictionary lookup would not exceed costs of indirect address authentication.

### Why it can be useful to disallow authentication with signature?

Ability to disallow authentication with signature enables two related use-cases:

1. Two-factor authentication schemes: where control over wallet is fully delegated to an extension that checks two signatures: the user’s one and the signature from the auth service. Naturally, if the signature authentication in the wallet remains allowed, the second factor check is bypassed.

2. Account recovery: delegating full control to another wallet in case of key compromise or loss. Wallet may contain larger amount of assets and its address could be tied to long-term contracts, therefore delegation to another controlling account is preferred to simply transferring the assets.

### What is library on masterchain?

Library is a special code storage mechanism that allows to reduce storage cost for a new Wallet V5 contract instance. Wallet V5 contract code is stored into a masterchain library. 
When wallet contract is being deployed, original code hash is being used as the contract code.
Library contract itself data and code are empty cells. That leads to the inability to change the library code, delete the contract, or withdraw funds from it.
Therefore, any Wallet V5 user can top up the library contract balance if they are afraid that the library code of their wallet will be frozen.

## TL-B definitions

See `types.tlb`.

## Source code

See [contracts/wallet_v5.fc](contracts/wallet_v5.fc).
