import { compile } from '@ton/blueprint';
import {
    Address,
    Cell,
    Dictionary,
    toNano,
    Transaction,
    internal as internal_relaxed,
    beginCell,
    SendMode,
    Sender,
    OutAction,
    OutActionSendMsg,
    contractAddress,
    ExternalAddress,
    storeOutAction
} from '@ton/core';
import '@ton/test-utils';
import {
    Blockchain,
    BlockchainSnapshot,
    EmulationError,
    SandboxContract,
    SendMessageResult,
    internal,
    TreasuryContract
} from '@ton/sandbox';
import { KeyPair, getSecureRandomBytes, keyPairFromSeed } from '@ton/crypto';
import { Opcodes, walletV5ConfigToCell } from '../wrappers/wallet-v5';
import { bufferToBigInt, getRandomInt, pickRandomNFrom } from './utils';
import { findTransactionRequired, randomAddress } from '@ton/test-utils';
import { estimateMessageImpact, getMsgPrices, MsgPrices, storageGeneric } from './gasUtils';
import { ErrorsV5 } from '../wrappers/Errors';
import {
    WalletV5Test,
    MessageOut,
    WalletActions,
    ExtendedAction,
    message2action,
    ExtensionAdd,
    ExtensionRemove
} from '../wrappers/wallet-v5-test';

describe('Wallet v5 external tests', () => {
    let blockchain: Blockchain;
    let keys: KeyPair;
    let wallet: SandboxContract<WalletV5Test>;
    let newWallet: SandboxContract<WalletV5Test>;
    let walletId: bigint;
    const validOpCodes = [
        Opcodes.auth_signed,
        Opcodes.auth_signed_internal,
        Opcodes.auth_extension
    ];
    const defaultExternalMode = SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS;

    let mockMessage: MessageOut;
    let owner: SandboxContract<TreasuryContract>;
    let testWalletBc: SandboxContract<TreasuryContract>;
    let testWalletMc: SandboxContract<TreasuryContract>;
    let testExtensionBc: SandboxContract<TreasuryContract>;
    let testExtensionMc: SandboxContract<TreasuryContract>;

    let initialState: BlockchainSnapshot;
    let hasExtension: BlockchainSnapshot;
    let hasMcWallet: BlockchainSnapshot;

    let msgPrices: MsgPrices;
    let msgPricesMc: MsgPrices;
    // let gasPrices: GasPrices;

    let code: Cell;

    let curTime: () => number;
    let loadFrom: (snap: BlockchainSnapshot) => Promise<void>;
    let getWalletData: (from?: Address) => Promise<Cell>;
    let someMessages: (num: number) => OutActionSendMsg[];
    let someExtensions: (
        num: number,
        action: 'add_extension' | 'remove_extension'
    ) => ExtendedAction[];
    let assertMockMessage: (txs: Transaction[], from?: Address) => void;
    let assertInternal: (txs: Transaction[], from: Address, exp: number) => void;
    let shouldRejectWith: (p: Promise<unknown>, code: number) => Promise<void>;
    let assertSendMessages: (
        exp: number,
        wallet_id: bigint,
        valid_until: number,
        seqno: bigint | number,
        messages: MessageOut[],
        key: Buffer,
        via?: Sender | ExtensionSender
    ) => Promise<SendMessageResult>;

    //type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
    type TestArgs = {
        walletId: bigint;
        valid_until: number;
        seqno: bigint | number;
        actions: WalletActions;
        key: Buffer;
        prevState?: Cell;
        extra?: any;
    };
    type TestCase = (arg: TestArgs) => Promise<SendMessageResult | void>;
    type ExtensionSender = (
        arg: WalletActions
    ) => Promise<{ op: number; res: SendMessageResult; is_inernal: boolean }>;

    /* Idea behind those wrappers is that we have common expectations of state
    /* Everything common between Internal/External/Extension actions goes to wrapper.
    /* Anything case specific goes to callbacks
    */
    let testSendModes: (
        internal: boolean,
        exp: number,
        mask: SendMode,
        modes: SendMode[],
        customSender?: ExtensionSender
    ) => Promise<void>;
    let extensionSender: ExtensionSender;
    let testSendInit: (shouldSucceed: TestCase, validateNewWallet: TestCase) => Promise<void>;
    let testSetCode: (shouldSucceed: TestCase, validate: TestCase) => Promise<void>;
    let testAddExt: (shouldSucceed: TestCase, custom_addr?: Address) => Promise<void>;
    let testAddExtAlreadyIn: (shouldFail: TestCase) => Promise<void>;
    let testAddExtWrongChain: (shouldFail: TestCase, validateOnMc: TestCase) => Promise<void>;
    let testRemoveExt: (shouldSucceed: TestCase) => Promise<void>;
    let testAddRemoveSend: (shouldSucceed: TestCase) => Promise<void>;
    let testRemoveExtNonExistent: (shouldSucceed: TestCase) => Promise<void>;

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        code = await compile('wallet_v5');
        keys = keyPairFromSeed(await getSecureRandomBytes(32));

        owner = await blockchain.treasury('wallet_owner');
        testWalletBc = await blockchain.treasury('test_wallet', { workchain: 0 });
        testWalletMc = await blockchain.treasury('test_wallet', { workchain: -1 });

        testExtensionBc = await blockchain.treasury('test_extension', { workchain: 0 });
        testExtensionMc = await blockchain.treasury('test_extension', { workchain: -1 });

        mockMessage = {
            message: internal_relaxed({
                to: testWalletBc.address,
                value: toNano('1'),
                body: beginCell().storeUint(0xdeadbeef, 32).endCell()
            }),
            mode: defaultExternalMode
        };

        msgPrices = getMsgPrices(blockchain.config, 0);
        msgPricesMc = getMsgPrices(blockchain.config, -1);

        walletId = BigInt(getRandomInt(10, 1337));
        wallet = blockchain.openContract(
            WalletV5Test.createFromConfig(
                {
                    seqno: 0,
                    walletId,
                    signatureAllowed: true,
                    publicKey: keys.publicKey,
                    extensions: Dictionary.empty()
                },
                code
            )
        );

        const deploy = await wallet.sendDeploy(owner.getSender(), toNano('100000'));

        expect(deploy.transactions).toHaveTransaction({
            on: wallet.address,
            from: owner.address,
            aborted: false,
            deploy: true
        });

        initialState = blockchain.snapshot();

        curTime = () => {
            return blockchain.now ?? Math.floor(Date.now() / 1000);
        };

        loadFrom = async snap => {
            if (snap == undefined) {
                throw new Error("Snapshot doesn't exist yet. Check tests order");
            }
            await blockchain.loadFrom(snap);
        };
        getWalletData = async (address?: Address) => {
            const contractAddress = address ?? wallet.address;
            const smc = await blockchain.getContract(contractAddress);
            if (!smc.account.account) throw 'Account not found';
            if (smc.account.account.storage.state.type != 'active')
                throw 'Atempting to get data on inactive account';
            if (!smc.account.account.storage.state.state.data) throw 'Data is not present';
            return smc.account.account.storage.state.state.data;
        };

        someMessages = n => {
            const messages: OutActionSendMsg[] = new Array(n);
            for (let i = 0; i < n; i++) {
                messages[i] = {
                    type: 'sendMsg',
                    mode: defaultExternalMode,
                    outMsg: internal_relaxed({
                        to: testWalletBc.address,
                        value: toNano('1'),
                        body: beginCell().storeUint(i, 32).endCell()
                    })
                };
            }
            return messages;
        };
        someExtensions = (n, action) => {
            const extensions: ExtendedAction[] = new Array(n);

            for (let i = 0; i < n; i++) {
                extensions[i] = {
                    type: action,
                    address: randomAddress()
                };
            }

            return extensions;
        };

        assertMockMessage = (txs, from) => {
            const fromAddr = from ?? wallet.address;
            expect(txs).toHaveTransaction({
                on: testWalletBc.address,
                from: fromAddr,
                value: toNano('1'),
                body: beginCell().storeUint(0xdeadbeef, 32).endCell()
            });
        };
        assertInternal = (txs, from, exp) => {
            const expSuccess = exp == 0;
            expect(txs).toHaveTransaction({
                on: wallet.address,
                from,
                success: expSuccess,
                aborted: !expSuccess,
                outMessagesCount: !expSuccess ? 1 : 0
            });
        };
        shouldRejectWith = async (p, code) => {
            try {
                const res = await p;
                console.log((res as any).transactions[0].description);
                throw new Error(`Should throw ${code}`);
            } catch (e: unknown) {
                if (e instanceof EmulationError) {
                    expect(e.exitCode !== undefined && e.exitCode == code).toBe(true);
                } else {
                    throw e;
                }
            }
        };

        assertSendMessages = async (exp, wallet_id, valid_until, seqno, messages, key, via) => {
            let res: SendMessageResult;
            let op: number;
            let isInternal: boolean;

            const smc = await blockchain.getContract(wallet.address);
            let balanceBefore = BigInt(smc.balance);

            if (typeof via == 'function') {
                const customRes = await via({ wallet: messages.map(message2action) });
                isInternal = customRes.is_inernal;
                res = customRes.res;
                op = customRes.op;
            } else {
                if (via) {
                    op = Opcodes.auth_signed_internal;
                    isInternal = true;
                    res = await wallet.sendMessagesInternal(
                        via,
                        wallet_id,
                        valid_until,
                        seqno,
                        key,
                        messages
                    );
                } else {
                    isInternal = false;
                    op = Opcodes.auth_signed;
                    res = await wallet.sendMessagesExternal(
                        wallet_id,
                        valid_until,
                        seqno,
                        key,
                        messages
                    );
                }
            }

            if (exp == 0) {
                const sendTx = findTransactionRequired(res.transactions, {
                    on: wallet.address,
                    op,
                    aborted: false,
                    outMessagesCount: messages.length
                });
                // console.log(sendTx.description);
                // console.log(sendTx.blockchainLogs);

                const storageFee = storageGeneric(sendTx).storageFeesCollected;

                balanceBefore -= storageFee;

                for (let i = 0; i < messages.length; i++) {
                    // console.log("Message:", i);
                    const msgOut = sendTx.outMessages.get(i)!;
                    if (msgOut.info.type == 'internal') {
                        const curPrices = msgOut.info.dest.workChain == 0 ? msgPrices : msgPricesMc;
                        const estMessage = estimateMessageImpact(
                            messages[i].message,
                            sendTx,
                            curPrices,
                            balanceBefore,
                            messages[i].mode,
                            i > 0
                        );
                        expect(res.transactions).toHaveTransaction({
                            on: msgOut.info.dest,
                            from: wallet.address,
                            value: estMessage.expValue,
                            body: msgOut.body
                        });
                        balanceBefore = estMessage.balanceAfter;
                    }
                }
                // console.log("Calculated balance:", balanceBefore);
                // console.log("Real balance:", smc.balance);
                expect(balanceBefore).toEqual(smc.balance);
            } else {
                expect(res.transactions).toHaveTransaction({
                    on: wallet.address,
                    outMessagesCount: isInternal ? 1 : 0, // On internal we should bounce
                    aborted: isInternal,
                    op,
                    exitCode: exp
                });
            }
            return res;
        };
        testSendModes = async (internal, exp, mask, modes, sender) => {
            let testMsgs: MessageOut[] = [];
            let i = 0;
            let seqNo = await wallet.getSeqno();
            const oldSeqno = seqNo;
            const prevState = blockchain.snapshot();
            const testSender = sender ?? internal ? owner.getSender() : undefined;
            /*
            if(testSender == sender) {
                console.log("Custom sender is working!");
            }
            */
            try {
                for (let mode of modes) {
                    // console.log("Testing mode:", mode);
                    const newMsg: MessageOut = {
                        message: internal_relaxed({
                            to: testWalletBc.address,
                            value: toNano(1),
                            body: beginCell().storeUint(i++, 32).endCell()
                        }),
                        mode: mode | mask
                    };
                    testMsgs.push(newMsg);

                    // Test in single mode first
                    await assertSendMessages(
                        exp,
                        walletId,
                        curTime() + 1000,
                        seqNo,
                        [newMsg],
                        keys.secretKey,
                        testSender
                    );
                    expect(await wallet.getSeqno()).toEqual(++seqNo);
                }

                await blockchain.loadFrom(prevState);

                // Now all at once
                await assertSendMessages(
                    exp,
                    walletId,
                    curTime() + 1000,
                    oldSeqno,
                    testMsgs,
                    keys.secretKey,
                    testSender
                );
                expect(await wallet.getSeqno()).toEqual(oldSeqno + 1);
            } finally {
                await blockchain.loadFrom(prevState);
            }
        };
        extensionSender = async actions => {
            const res = await wallet.sendExtensionActions(testExtensionBc.getSender(), actions);
            return {
                is_inernal: true,
                res,
                op: Opcodes.auth_extension
            };
        };
        testSendInit = async (shouldWork, validateNewWallet) => {
            let newWalletId: bigint;
            let seqNo = await wallet.getSeqno();

            do {
                newWalletId = BigInt(getRandomInt(1000, 100000));
            } while (newWalletId == walletId);

            const newWalletData = walletV5ConfigToCell({
                walletId: newWalletId,
                seqno: 0,
                signatureAllowed: true,
                publicKey: keys.publicKey, // Same key
                extensions: Dictionary.empty()
            });

            // Deploying it to masterchain
            const newAddress = contractAddress(-1, { code, data: newWalletData });

            const testArgs: TestArgs = {
                walletId,
                valid_until: curTime() + 100,
                seqno: seqNo,
                actions: {
                    wallet: [
                        {
                            type: 'sendMsg',
                            outMsg: internal_relaxed({
                                to: newAddress,
                                value: toNano('100'),
                                init: {
                                    code,
                                    data: newWalletData
                                }
                            }),
                            mode: defaultExternalMode
                        }
                    ]
                },
                key: keys.secretKey,
                extra: { new_address: newAddress }
            };

            await shouldWork(testArgs);

            newWallet = blockchain.openContract(WalletV5Test.createFromAddress(newAddress));

            // New wallet should be able to send message with current key

            await validateNewWallet({
                walletId: newWalletId,
                valid_until: curTime() + 100,
                seqno: 0,
                actions: {}, // Won't be used by this handler anyway
                key: keys.secretKey
            });
            // res = await newWallet.sendMessagesExternal(newWalletId, curTime() + 100, 0, keys.secretKey, [mockMessage]);

            // Let's test getters while we can
            expect((await newWallet.getWalletId()).subwalletNumber).toEqual(Number(newWalletId));
            expect(await newWallet.getPublicKey()).toEqual(bufferToBigInt(keys.publicKey));
            expect(await newWallet.getIsSignatureAuthAllowed()).toBe(-1);

            hasMcWallet = blockchain.snapshot();
        };
        testSetCode = async (testCb, validateCb) => {
            let testMsgs: OutAction[] = new Array(254);
            const newCode = beginCell().storeUint(getRandomInt(0, 1000), 32).endCell();
            let seqNo = await wallet.getSeqno();

            const setCodeAction: OutAction = {
                type: 'setCode',
                newCode
            };

            testMsgs = someMessages(254); // Saving space for set_code

            const onlySetCode = [setCodeAction];
            const setCodeLast = [...testMsgs, setCodeAction];
            const setCodeFirst = [setCodeAction, ...testMsgs];
            const setCodeShuffle = [...testMsgs];

            const setCodeIdx = getRandomInt(1, setCodeShuffle.length - 1);
            // Just replace some random position with setCode
            setCodeShuffle[setCodeIdx] = setCodeAction;

            const extraSetCode = [...setCodeShuffle];
            let newIdx = setCodeIdx;

            do {
                newIdx = getRandomInt(1, setCodeShuffle.length - 1);
            } while (newIdx == setCodeIdx);
            // Insert another one, in case code removes first matched only
            extraSetCode[newIdx] = setCodeAction;

            const prevState = await getWalletData();
            const defaultArgs = {
                walletId,
                seqno: seqNo,
                valid_until: curTime() + 1000,
                key: keys.secretKey,
                prevState
            };
            for (let actionSet of [
                onlySetCode,
                setCodeLast,
                setCodeFirst,
                setCodeShuffle,
                extraSetCode
            ]) {
                //const setCodeRequest = WalletV5Test.requestMessage(false, walletId, curTime() + 100, seqNo, {wallet: actionSet}, keys.secretKey);
                const negTestArgs: TestArgs = {
                    ...defaultArgs,
                    seqno: seqNo,
                    actions: { wallet: actionSet }
                };
                // const negTestArgs: TestArgs = {...defaultArgs, actions: {wallet: actionSet}};
                await testCb(negTestArgs);
                seqNo = await wallet.getSeqno();
            }

            // Validate that it has nothing to do with message list
            await validateCb({ ...defaultArgs, seqno: seqNo, actions: { wallet: testMsgs } });
        };
        testAddExt = async (checkTx, customAddr) => {
            let seqNo = await wallet.getSeqno();

            const extensionAddr = customAddr ?? testExtensionBc.address;
            const testArgs: TestArgs = {
                walletId,
                valid_until: curTime() + 100,
                seqno: seqNo,
                actions: {
                    extended: [
                        {
                            type: 'add_extension',
                            address: extensionAddr
                        }
                    ]
                },
                key: keys.secretKey
            };

            await checkTx(testArgs);

            const installedExt = await wallet.getExtensionsArray();
            expect(installedExt.findIndex(a => a.equals(extensionAddr))).toBeGreaterThanOrEqual(0);
            // expect(await wallet.getSeqno()).toEqual(seqNo + 1);
        };
        testAddExtAlreadyIn = async checkTx => {
            await loadFrom(hasExtension);

            const installedBefore = await wallet.getExtensionsArray();
            let seqNo = await wallet.getSeqno();

            const testArgs: TestArgs = {
                walletId,
                valid_until: curTime() + 100,
                seqno: seqNo,
                actions: {
                    extended: [
                        {
                            type: 'add_extension',
                            address: testExtensionBc.address
                        }
                    ]
                },
                key: keys.secretKey
            };

            await checkTx(testArgs);

            const installedAfter = await wallet.getExtensionsArray();
            expect(installedBefore.length).toEqual(installedAfter.length);

            for (let i = 0; i < installedBefore.length; i++) {
                expect(installedBefore[i].equals(installedAfter[i])).toBe(true);
            }
        };
        testAddExtWrongChain = async (shouldReject, validate) => {
            const prevState = blockchain.snapshot();
            let seqNo = await wallet.getSeqno();
            const installedBefore = await wallet.getExtensionsArray();

            let testArgs: TestArgs = {
                walletId,
                valid_until: curTime() + 100,
                seqno: seqNo,
                actions: {
                    extended: [
                        {
                            type: 'add_extension',
                            address: testExtensionMc.address
                        }
                    ]
                },
                key: keys.secretKey
            };

            await shouldReject(testArgs);

            const installedAfter = await wallet.getExtensionsArray();
            expect(installedBefore.length).toEqual(installedAfter.length);

            for (let i = 0; i < installedBefore.length; i++) {
                expect(installedBefore[i].equals(installedAfter[i])).toBe(true);
            }
            // But it should work for the wallet in basechain

            const newSeqNo = await newWallet.getSeqno();
            const newId = BigInt((await newWallet.getWalletId()).subwalletNumber);

            testArgs = {
                walletId: newId,
                valid_until: curTime() + 100,
                seqno: newSeqNo,
                actions: {
                    extended: [
                        {
                            type: 'add_extension',
                            address: testExtensionMc.address
                        }
                    ]
                },
                key: keys.secretKey
            };

            let installedExt = await newWallet.getExtensionsArray();
            expect(installedExt.findIndex(a => a.equals(testExtensionMc.address))).toBe(-1);

            await validate(testArgs);

            installedExt = await newWallet.getExtensionsArray();
            expect(
                installedExt.findIndex(a => a.equals(testExtensionMc.address))
            ).toBeGreaterThanOrEqual(0);
            // expect(await wallet.getSeqno()).toEqual(seqNo + 1);

            await loadFrom(prevState);
        };
        testRemoveExt = async shouldRemove => {
            await loadFrom(hasExtension);
            let seqNo = await wallet.getSeqno();
            let installedExt = await wallet.getExtensionsArray();
            expect(installedExt[0].equals(testExtensionBc.address)).toBe(true);

            const testArgs: TestArgs = {
                walletId,
                valid_until: curTime() + 100,
                seqno: seqNo,
                actions: {
                    extended: [
                        {
                            type: 'remove_extension',
                            address: testExtensionBc.address
                        }
                    ]
                },
                key: keys.secretKey
            };

            await shouldRemove(testArgs);

            installedExt = await wallet.getExtensionsArray();
            expect(installedExt.findIndex(a => a.equals(testExtensionBc.address))).toBe(-1);
        };
        testRemoveExtNonExistent = async shouldFail => {
            await loadFrom(hasExtension);
            let seqNo = await wallet.getSeqno();
            const differentExt = await blockchain.treasury('totally different extension');
            const installedBefore = await wallet.getExtensionsArray();

            expect(installedBefore.length).toBe(1);
            expect(installedBefore[0].equals(testExtensionBc.address)).toBe(true);

            const testArgs: TestArgs = {
                walletId,
                valid_until: curTime() + 100,
                seqno: seqNo,
                actions: {
                    extended: [
                        {
                            type: 'remove_extension',
                            address: differentExt.address
                        }
                    ]
                },
                key: keys.secretKey
            };
            await shouldFail(testArgs);

            const extAfter = await wallet.getExtensionsArray();
            expect(extAfter.length).toBe(1);
            // expect(await wallet.getSeqno()).toEqual(seqNo + 1);
            expect(
                extAfter.findIndex(e => e.equals(testExtensionBc.address))
            ).toBeGreaterThanOrEqual(0);
        };
        testAddRemoveSend = async shouldWork => {
            const prevState = blockchain.snapshot();
            const seqNo = await wallet.getSeqno();

            const extBefore = await wallet.getExtensionsArray();
            const testMessages = someMessages(255); // Full pack
            const testExtensions = someExtensions(100, 'add_extension');

            // Let's pick some of those for removal
            const removeExt = pickRandomNFrom(5, testExtensions).map(e => {
                const res: ExtensionRemove = {
                    type: 'remove_extension',
                    address: (e as ExtensionAdd).address
                };
                return res;
            });
            // console.log("Remove extensions:", removeExt);
            const shouldStay = (testExtensions as ExtensionAdd[])
                .filter(e => removeExt.find(r => r.address.equals(e.address)) == undefined)
                .map(e => e.address);
            shouldStay.push(...extBefore);
            testExtensions.push(...removeExt);

            const testArgs: TestArgs = {
                walletId,
                valid_until: curTime() + 100,
                seqno: seqNo,
                actions: {
                    wallet: testMessages,
                    extended: testExtensions
                },
                key: keys.secretKey
            };

            await shouldWork(testArgs);

            const extAfter = await wallet.getExtensionsArray();

            expect(extAfter.length).toEqual(shouldStay.length);
            for (let i = 0; i < shouldStay.length; i++) {
                const testAddr = shouldStay[i];
                expect(extAfter.findIndex(addr => addr.equals(testAddr))).toBeGreaterThanOrEqual(0);
                expect(removeExt.findIndex(e => e.address.equals(testAddr))).toBe(-1);
            }
            // expect(await wallet.getSeqno()).toEqual(seqNo + 1);
            await loadFrom(prevState);
        };
    });
    describe('Basic', () => {
        it('should deploy', async () => {});
        it('should be able to receive basic transfer', async () => {
            const testWallet = await blockchain.treasury('test_wallet');
            const assertSimple = async (body?: Cell) => {
                const res = await testWallet.send({
                    to: wallet.address,
                    value: toNano(getRandomInt(1, 100)),
                    body,
                    sendMode: SendMode.PAY_GAS_SEPARATELY
                });
                expect(res.transactions).toHaveTransaction({
                    on: wallet.address,
                    from: testWallet.address,
                    aborted: false,
                    outMessagesCount: 0
                });
            };

            await assertSimple();
            await assertSimple(
                beginCell().storeUint(0, 32).storeStringTail('Hey, bruh!').endCell()
            );

            const validSet = new Set(validOpCodes);
            let testOp: number;

            do {
                testOp = getRandomInt(1, (1 << 32) - 1);
            } while (validSet.has(testOp));

            await assertSimple(
                beginCell().storeUint(testOp, 32).storeUint(curTime(), 64).endCell()
            );
        });
    });
    describe('Actions', () => {
        describe('External', () => {
            it('should be able to send message to arbitrary address', async () => {
                const msgValue = toNano(getRandomInt(1, 10));
                const randomBody = beginCell().storeUint(curTime(), 64).endCell();
                const seqNo = BigInt(await wallet.getSeqno());

                await assertSendMessages(
                    0,
                    walletId,
                    curTime() + 1000,
                    seqNo,
                    [
                        {
                            message: internal_relaxed({
                                to: testWalletBc.address,
                                value: msgValue,
                                body: randomBody
                            }),
                            mode: defaultExternalMode
                        },
                        {
                            message: internal_relaxed({
                                to: testWalletMc.address,
                                value: msgValue,
                                body: randomBody
                            }),
                            mode: defaultExternalMode
                        }
                    ],
                    keys.secretKey
                );

                const seqnoAfter = BigInt(await wallet.getSeqno());
                expect(seqnoAfter).toEqual(seqNo + 1n);
            });
            it('should reject message with wrong signature', async () => {
                const seqNo = await wallet.getSeqno();
                const badKeys = keyPairFromSeed(await getSecureRandomBytes(32));

                await shouldRejectWith(
                    wallet.sendMessagesExternal(
                        walletId,
                        curTime() + 1000,
                        seqNo,
                        badKeys.secretKey,
                        [mockMessage]
                    ),
                    ErrorsV5.invalid_signature
                );
                expect(await wallet.getSeqno()).toEqual(seqNo);

                const res = await wallet.sendMessagesExternal(
                    walletId,
                    curTime() + 1000,
                    seqNo,
                    keys.secretKey,
                    [mockMessage]
                );
                expect(res.transactions).toHaveTransaction({
                    on: wallet.address,
                    op: Opcodes.auth_signed,
                    aborted: false,
                    outMessagesCount: 1
                });
            });
            it('should reject external message with prefix other than signed_external', async () => {
                // All of the valid ops except acceptable, plus one random
                const nonExternalOps = [
                    ...validOpCodes.filter(op => op != Opcodes.auth_signed),
                    0xdeadbeef
                ];
                const seqNo = await wallet.getSeqno();
                const validMsg = WalletV5Test.requestMessage(
                    false,
                    walletId,
                    curTime() + 1000,
                    BigInt(seqNo),
                    {}
                );
                const msgTail = validMsg.beginParse().skip(32); // skip op;

                for (let op of nonExternalOps) {
                    const newMsg = WalletV5Test.signRequestMessage(
                        beginCell().storeUint(op, 32).storeSlice(msgTail).endCell(),
                        keys.secretKey
                    );
                    await shouldRejectWith(
                        wallet.sendExternalSignedMessage(newMsg),
                        ErrorsV5.invalid_message_operation
                    );
                    // Should not change seqno
                    expect(await wallet.getSeqno()).toEqual(seqNo);
                }

                // Validate that original message works
                const res = await wallet.sendExternalSignedMessage(
                    WalletV5Test.signRequestMessage(validMsg, keys.secretKey)
                );
                expect(res.transactions).toHaveTransaction({
                    on: wallet.address,
                    op: Opcodes.auth_signed,
                    aborted: false
                });
                expect(await wallet.getSeqno()).toEqual(seqNo + 1);
            });
            it('should be able to send up to 255 messages', async () => {
                let testMsgs: MessageOut[] = new Array(255);
                const seqNo = BigInt(await wallet.getSeqno());

                for (let i = 0; i < 255; i++) {
                    testMsgs[i] = {
                        message: internal_relaxed({
                            to: testWalletBc.address,
                            value: toNano('1'),
                            body: beginCell().storeUint(i, 32).endCell()
                        }),
                        mode: defaultExternalMode
                    };
                }

                await assertSendMessages(
                    0,
                    walletId,
                    curTime() + 1000,
                    seqNo,
                    testMsgs,
                    keys.secretKey
                );
            });
            it('should be able to send messages with different send modes', async () => {
                await testSendModes(false, 0, SendMode.IGNORE_ERRORS, [
                    SendMode.NONE,
                    SendMode.PAY_GAS_SEPARATELY,
                    SendMode.CARRY_ALL_REMAINING_BALANCE
                ]);
            });
            it('should reject send modes without IGNORE_ERRORS', async () => {
                await testSendModes(
                    false,
                    ErrorsV5.external_send_message_must_have_ignore_errors_send_mode,
                    0,
                    [
                        SendMode.NONE,
                        SendMode.PAY_GAS_SEPARATELY,
                        SendMode.CARRY_ALL_REMAINING_BALANCE,
                        SendMode.CARRY_ALL_REMAINING_BALANCE | SendMode.DESTROY_ACCOUNT_IF_ZERO
                    ]
                );
            });
            it('should be able to send message with init state', async () => {
                await testSendInit(
                    async args => {
                        if (!Address.isAddress(args.extra.new_address)) {
                            throw new TypeError('Callback requires wallet address');
                        }
                        const reqMsg = WalletV5Test.requestMessage(
                            false,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendExternalSignedMessage(reqMsg);
                        expect(res.transactions).toHaveTransaction({
                            on: args.extra.new_address,
                            aborted: false,
                            deploy: true
                        });
                    },
                    async args => {
                        // New wallet should be able to send from new wallet via external
                        const res = await newWallet.sendMessagesExternal(
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.key,
                            [mockMessage]
                        );
                        assertMockMessage(res.transactions, newWallet.address);
                    }
                );
            });
            it('should be able to send external message', async () => {
                const seqNo = await wallet.getSeqno();
                const testPayload = BigInt(getRandomInt(0, 100000));
                const testBody = beginCell().storeUint(testPayload, 32).endCell();

                const res = await wallet.sendMessagesExternal(
                    walletId,
                    curTime() + 100,
                    seqNo,
                    keys.secretKey,
                    [
                        {
                            message: {
                                info: {
                                    type: 'external-out',
                                    createdAt: 0,
                                    createdLt: 0n,
                                    dest: new ExternalAddress(testPayload, 32),
                                    src: null
                                },
                                body: testBody
                            },
                            mode: defaultExternalMode
                        }
                    ]
                );

                const txSuccess = findTransactionRequired(res.transactions, {
                    on: wallet.address,
                    op: Opcodes.auth_signed,
                    aborted: false
                });

                expect(txSuccess.externals.length).toBe(1);

                const extOut = txSuccess.externals[0];

                expect(extOut.info.dest!.value).toBe(testPayload);
                expect(extOut.body).toEqualCell(testBody);
            });
            it('should reject message with invalid seqno', async () => {
                const seqNo = await wallet.getSeqno();
                expect(seqNo).toBeGreaterThan(2); // For better test
                const testDelta = getRandomInt(2, seqNo);

                for (let testSeq of [seqNo - 1, seqNo + 1, seqNo + testDelta, seqNo - testDelta]) {
                    await shouldRejectWith(
                        wallet.sendMessagesExternal(
                            walletId,
                            curTime() + 100,
                            testSeq,
                            keys.secretKey,
                            [mockMessage]
                        ),
                        ErrorsV5.invalid_seqno
                    );
                    expect(await wallet.getSeqno()).toEqual(seqNo);
                }
            });
            it('should reject message with invalid subwallet', async () => {
                const seqNo = await wallet.getSeqno();
                const testDelta = BigInt(getRandomInt(2, Number(walletId)));

                for (let testId of [
                    walletId - 1n,
                    walletId + 1n,
                    walletId - testDelta,
                    walletId + testDelta
                ]) {
                    await shouldRejectWith(
                        wallet.sendMessagesExternal(
                            testId,
                            curTime() + 100,
                            seqNo,
                            keys.secretKey,
                            [mockMessage]
                        ),
                        ErrorsV5.invalid_wallet_id
                    );
                    expect(await wallet.getSeqno()).toEqual(seqNo);
                }
            });
            it('should reject expired message', async () => {
                blockchain.now = curTime(); // Stop ticking
                const seqNo = await wallet.getSeqno();
                const testDelta = getRandomInt(1, 10000);

                // We're treating current time as expired. Should we?
                for (let testUntil of [blockchain.now, blockchain.now - testDelta]) {
                    await shouldRejectWith(
                        wallet.sendMessagesExternal(walletId, testUntil, seqNo, keys.secretKey, [
                            mockMessage
                        ]),
                        ErrorsV5.expired
                    );
                    expect(await wallet.getSeqno()).toEqual(seqNo);
                }

                const res = await wallet.sendMessagesExternal(
                    walletId,
                    blockchain.now + 1,
                    seqNo,
                    keys.secretKey,
                    [mockMessage]
                );

                assertMockMessage(res.transactions);
                expect(await wallet.getSeqno()).toEqual(seqNo + 1);
            });
            it('should reject set_code action', async () => {
                await testSetCode(
                    async args => {
                        if (args.actions == undefined || args.key == undefined) {
                            throw new Error('Actions and keys are required');
                        }
                        const setCodeRequest = WalletV5Test.requestMessage(
                            false,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendExternalSignedMessage(setCodeRequest);
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            op: Opcodes.auth_signed,
                            outMessagesCount: 0,
                            success: true, // Because of commit call
                            exitCode: 9
                        });
                        expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                    },
                    async args => {
                        if (args.actions == undefined || args.key == undefined) {
                            throw new Error('Actions and keys are required');
                        }
                        const sendJustMessages = WalletV5Test.requestMessage(
                            false,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendExternalSignedMessage(sendJustMessages);
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            op: Opcodes.auth_signed,
                            aborted: false,
                            outMessagesCount: 254,
                            exitCode: 0
                        });
                        expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                    }
                );
            });
            it('should be able to add extension', async () => {
                await testAddExt(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        false,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendExternalSignedMessage(reqMsg);
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        op: Opcodes.auth_signed,
                        outMessagesCount: 0,
                        exitCode: 0 // Because of commit we can't rely on compute phase status
                    });
                    expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                });

                hasExtension = blockchain.snapshot();
            });
            it('should not be able to install already installed extendsion', async () => {
                await testAddExtAlreadyIn(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        false,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendExternalSignedMessage(reqMsg);
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        op: Opcodes.auth_signed,
                        outMessagesCount: 0,
                        exitCode: ErrorsV5.add_extension
                    });
                    expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                });
            });
            it('should not be able to install extension from different chain', async () => {
                await testAddExtWrongChain(
                    async args => {
                        const reqMsg = WalletV5Test.requestMessage(
                            false,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendExternalSignedMessage(reqMsg);
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            op: Opcodes.auth_signed,
                            outMessagesCount: 0,
                            exitCode: ErrorsV5.extension_wrong_workchain
                        });
                        expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                    },
                    async args => {
                        const reqMsg = WalletV5Test.requestMessage(
                            false,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await newWallet.sendExternalSignedMessage(reqMsg);
                        expect(res.transactions).toHaveTransaction({
                            on: newWallet.address,
                            op: Opcodes.auth_signed,
                            outMessagesCount: 0,
                            exitCode: 0 // We're good now
                        });
                        expect(await newWallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                    }
                );
            });
            it('should be able to remove extension', async () => {
                await testRemoveExt(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        false,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendExternalSignedMessage(reqMsg);

                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        op: Opcodes.auth_signed,
                        outMessagesCount: 0,
                        exitCode: 0 // Because of commit we can't rely on compute phase status
                    });
                });
            });
            it('should throw on removing non-existent extension', async () => {
                await testRemoveExtNonExistent(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        false,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendExternalSignedMessage(reqMsg);
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        op: Opcodes.auth_signed,
                        outMessagesCount: 0,
                        exitCode: ErrorsV5.remove_extension
                    });
                    expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                });
            });
            // Doesn't make much sense, since inderectly tested in too many places
            it.skip('empty action list should increase seqno', async () => {
                const seqNo = await wallet.getSeqno();
                const testMsg = WalletV5Test.requestMessage(
                    false,
                    walletId,
                    curTime() + 100,
                    seqNo,
                    {},
                    keys.secretKey
                );
                const res = await wallet.sendExternalSignedMessage(testMsg);

                expect(await wallet.getSeqno()).toEqual(seqNo + 1);
            });
            it('should be able to add/remove extensions and send messages in one go', async () => {
                await testAddRemoveSend(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        false,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendExternalSignedMessage(reqMsg);
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        aborted: false,
                        outMessagesCount: 255
                    });
                    expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                });
            });
        });
        describe('Internal', () => {
            it('should be able to send message to arbitrary address', async () => {
                const msgValue = toNano(getRandomInt(1, 10));
                const randomBody = beginCell().storeUint(curTime(), 64).endCell();
                const seqNo = BigInt(await wallet.getSeqno());

                const res = await assertSendMessages(
                    0,
                    walletId,
                    curTime() + 1000,
                    seqNo,
                    [
                        {
                            message: internal_relaxed({
                                to: testWalletBc.address,
                                value: msgValue,
                                body: randomBody
                            }),
                            mode: SendMode.PAY_GAS_SEPARATELY
                        },
                        {
                            message: internal_relaxed({
                                to: testWalletMc.address,
                                value: msgValue,
                                body: randomBody
                            }),
                            mode: SendMode.PAY_GAS_SEPARATELY
                        }
                    ],
                    keys.secretKey,
                    owner.getSender()
                );

                const seqnoAfter = BigInt(await wallet.getSeqno());
                expect(seqnoAfter).toEqual(seqNo + 1n);
            });
            it('should ignore message with wrong signature', async () => {
                const seqNo = await wallet.getSeqno();
                const badKeys = keyPairFromSeed(await getSecureRandomBytes(32));
                const stateBefore = await getWalletData();

                const msgActions = [message2action(mockMessage)];
                let testMsg = WalletV5Test.requestMessage(
                    true,
                    walletId,
                    curTime() + 100,
                    seqNo,
                    { wallet: msgActions },
                    badKeys.secretKey
                );
                let res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                    value: toNano('1'),
                    body: testMsg
                });
                assertInternal(res.transactions, owner.address, 0);
                expect(await getWalletData()).toEqualCell(stateBefore);

                testMsg = WalletV5Test.requestMessage(
                    true,
                    walletId,
                    curTime() + 100,
                    seqNo,
                    { wallet: msgActions },
                    keys.secretKey
                );
                res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                    value: toNano('1'),
                    body: testMsg
                });
                assertMockMessage(res.transactions);
                expect(await wallet.getSeqno()).toEqual(seqNo + 1);
            });

            it('should bounce message with invalid subwallet', async () => {
                const seqNo = await wallet.getSeqno();
                const testDelta = BigInt(getRandomInt(2, Number(walletId)));
                const stateBefore = await getWalletData();

                for (let testId of [
                    walletId - 1n,
                    walletId + 1n,
                    walletId - testDelta,
                    walletId + testDelta
                ]) {
                    const res = await wallet.sendMessagesInternal(
                        owner.getSender(),
                        testId,
                        curTime() + 100,
                        seqNo,
                        keys.secretKey,
                        [mockMessage]
                    );
                    assertInternal(res.transactions, owner.address, ErrorsV5.invalid_wallet_id);
                    expect(await getWalletData()).toEqualCell(stateBefore);
                }
            });
            it('should bounce expired message', async () => {
                blockchain.now = curTime(); // Stop ticking
                const seqNo = await wallet.getSeqno();
                const testDelta = getRandomInt(1, 10000);
                const stateBefore = await getWalletData();

                // We're treating current time as expired. Should we?
                for (let testUntil of [blockchain.now, blockchain.now - testDelta]) {
                    const res = await wallet.sendMessagesInternal(
                        owner.getSender(),
                        walletId,
                        testUntil,
                        seqNo,
                        keys.secretKey,
                        [mockMessage]
                    );
                    assertInternal(res.transactions, owner.address, ErrorsV5.expired);
                    expect(await getWalletData()).toEqualCell(stateBefore);
                }

                const res = await wallet.sendMessagesExternal(
                    walletId,
                    blockchain.now + 1,
                    seqNo,
                    keys.secretKey,
                    [mockMessage]
                );
                assertMockMessage(res.transactions);
                expect(await wallet.getSeqno()).toEqual(seqNo + 1);
            });
            it('should reject set_code action', async () => {
                await testSetCode(
                    async args => {
                        const setCodeRequest = WalletV5Test.requestMessage(
                            true,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                            value: toNano('1'),
                            body: setCodeRequest
                        });
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            op: Opcodes.auth_signed_internal,
                            outMessagesCount: 1, // bounce
                            aborted: true,
                            success: false, // No commit anymore
                            exitCode: 9
                        });
                        expect(await wallet.getSeqno()).toEqual(Number(args.seqno)); // On internal seqno is not commited
                    },
                    async args => {
                        if (args.actions == undefined || args.key == undefined) {
                            throw new Error('Actions and keys are required');
                        }
                        const sendJustMessages = WalletV5Test.requestMessage(
                            false,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendExternalSignedMessage(sendJustMessages);
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            op: Opcodes.auth_signed,
                            aborted: false,
                            outMessagesCount: 254,
                            exitCode: 0
                        });
                        expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                    }
                );
            });
            it('should bounce message with invalid seqno', async () => {
                const seqNo = await wallet.getSeqno();
                expect(seqNo).toBeGreaterThan(2); // For better test
                const testDelta = getRandomInt(2, seqNo);
                const stateBefore = await getWalletData();

                for (let testSeq of [seqNo - 1, seqNo + 1, seqNo + testDelta, seqNo - testDelta]) {
                    const res = await wallet.sendMessagesInternal(
                        owner.getSender(),
                        walletId,
                        curTime() + 100,
                        testSeq,
                        keys.secretKey,
                        [mockMessage]
                    );
                    assertInternal(res.transactions, owner.address, ErrorsV5.invalid_seqno);
                    expect(await getWalletData()).toEqualCell(stateBefore);
                }
            });
            it('should ignore internal message with prefix other than signed_internal', async () => {
                // All of the valid ops except acceptable, plus one random
                const nonExternalOps = [
                    ...validOpCodes.filter(op => op != Opcodes.auth_signed_internal),
                    0xdeadbeef
                ];
                const seqNo = await wallet.getSeqno();
                // Not yet signed
                const validMsg = WalletV5Test.requestMessage(
                    true,
                    walletId,
                    curTime() + 1000,
                    BigInt(seqNo),
                    {}
                );
                const msgTail = validMsg.beginParse().skip(32); // skip op;

                for (let op of nonExternalOps) {
                    const newMsg = WalletV5Test.signRequestMessage(
                        beginCell().storeUint(op, 32).storeSlice(msgTail).endCell(),
                        keys.secretKey
                    );
                    const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                        value: toNano('1'),
                        body: newMsg
                    });
                    assertInternal(res.transactions, owner.address, 0); // return no bounce
                    // Should not change seqno
                    expect(await wallet.getSeqno()).toEqual(seqNo);
                }

                // Validate that original message works
                const successMsg = WalletV5Test.signRequestMessage(validMsg, keys.secretKey);
                const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                    value: toNano('1'),
                    body: successMsg
                });
                assertInternal(res.transactions, owner.address, 0);
                expect(await wallet.getSeqno()).toEqual(seqNo + 1);
            });
            it('should ignore internal message with correct prefix, but incorrect length', async () => {
                const seqNo = await wallet.getSeqno();
                // So we have message with bad wallet id
                const badMsg = WalletV5Test.requestMessage(
                    true,
                    walletId - 1n,
                    curTime() + 1000,
                    BigInt(seqNo),
                    {},
                    keys.secretKey
                );

                // Now we have it's truncated version
                const msgTrunc = beginCell()
                    .storeBits(badMsg.beginParse().loadBits(badMsg.bits.length - 10))
                    .endCell(); // off by one

                let res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                    value: toNano('1'),
                    body: msgTrunc
                });
                // Now, because it's truncated it gets ignored
                assertInternal(res.transactions, owner.address, 0);

                res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                    value: toNano('1'),
                    body: badMsg
                });
                assertInternal(res.transactions, owner.address, ErrorsV5.invalid_wallet_id);
                // If we send it as is, the subwallet exception will trigger
            });
            it('should be able to send up to 255 messages', async () => {
                let testMsgs: MessageOut[] = new Array(255);
                const seqNo = BigInt(await wallet.getSeqno());

                for (let i = 0; i < 255; i++) {
                    testMsgs[i] = {
                        message: internal_relaxed({
                            to: testWalletBc.address,
                            value: toNano('1'),
                            body: beginCell().storeUint(i, 32).endCell()
                        }),
                        mode: defaultExternalMode
                    };
                }
                await assertSendMessages(
                    0,
                    walletId,
                    curTime() + 1000,
                    seqNo,
                    testMsgs,
                    keys.secretKey
                );
            });
            it('should be able to send message with init state', async () => {
                await testSendInit(
                    async args => {
                        if (!Address.isAddress(args.extra.new_address)) {
                            throw new TypeError('Callback requires wallet address');
                        }
                        const reqMsg = WalletV5Test.requestMessage(
                            true,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                            value: toNano('1'),
                            body: reqMsg
                        });

                        expect(res.transactions).toHaveTransaction({
                            on: args.extra.new_address,
                            aborted: false,
                            deploy: true
                        });
                    },
                    async args => {
                        // New wallet should be able to send from new wallet via external
                        const res = await newWallet.sendMessagesInternal(
                            owner.getSender(),
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.key,
                            [mockMessage],
                            toNano('1')
                        );
                        assertMockMessage(res.transactions, newWallet.address);
                    }
                );
            });
            it('should be able to send external message', async () => {
                const seqNo = await wallet.getSeqno();
                const testPayload = BigInt(getRandomInt(0, 100000));
                const testBody = beginCell().storeUint(testPayload, 32).endCell();

                const res = await wallet.sendMessagesInternal(
                    owner.getSender(),
                    walletId,
                    curTime() + 100,
                    seqNo,
                    keys.secretKey,
                    [
                        {
                            message: {
                                info: {
                                    type: 'external-out',
                                    createdAt: 0,
                                    createdLt: 0n,
                                    dest: new ExternalAddress(testPayload, 32),
                                    src: null
                                },
                                body: testBody
                            },
                            mode: defaultExternalMode
                        }
                    ]
                );

                const txSuccess = findTransactionRequired(res.transactions, {
                    on: wallet.address,
                    from: owner.address,
                    op: Opcodes.auth_signed_internal,
                    aborted: false
                });

                expect(txSuccess.externals.length).toBe(1);

                const extOut = txSuccess.externals[0];

                expect(extOut.info.dest!.value).toBe(testPayload);
                expect(extOut.body).toEqualCell(testBody);
            });

            it('should be able to send messages with various send modes', async () => {
                // Internal should work with
                await testSendModes(true, 0, SendMode.IGNORE_ERRORS, [
                    SendMode.NONE,
                    SendMode.PAY_GAS_SEPARATELY,
                    SendMode.CARRY_ALL_REMAINING_INCOMING_VALUE,
                    SendMode.CARRY_ALL_REMAINING_BALANCE
                ]);
                // And without IGNORE_ERRORS
                await testSendModes(true, 0, 0, [
                    SendMode.NONE,
                    SendMode.PAY_GAS_SEPARATELY,
                    SendMode.CARRY_ALL_REMAINING_INCOMING_VALUE,
                    SendMode.CARRY_ALL_REMAINING_BALANCE
                ]);
            });
            it('should bounce on set_code action', async () => {
                await testSetCode(
                    async args => {
                        if (
                            args.actions == undefined ||
                            args.key == undefined ||
                            args.prevState == undefined
                        ) {
                            throw new Error('Actions keys and state are required');
                        }
                        const setCodeRequest = WalletV5Test.requestMessage(
                            true,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                            value: toNano('1'),
                            body: setCodeRequest
                        });
                        assertInternal(res.transactions, owner.address, 9);
                        expect(await getWalletData()).toEqualCell(args.prevState);
                    },
                    async args => {
                        if (
                            args.actions == undefined ||
                            args.key == undefined ||
                            args.prevState == undefined
                        ) {
                            throw new Error('Actions keys and state are required');
                        }
                        const sendJustMessages = WalletV5Test.requestMessage(
                            true,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                            value: toNano('1'),
                            body: sendJustMessages
                        });
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            op: Opcodes.auth_signed_internal,
                            aborted: false,
                            outMessagesCount: 254,
                            exitCode: 0
                        });
                        expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                    }
                );
            });
            it('should be able to add extension', async () => {
                await loadFrom(initialState);
                await testAddExt(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        true,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                        value: toNano('1'),
                        body: reqMsg
                    });
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        from: owner.address,
                        op: Opcodes.auth_signed_internal,
                        outMessagesCount: 0,
                        aborted: false,
                        exitCode: 0
                    });
                    expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                });
                hasExtension = blockchain.snapshot();
            });
            it('should not be able to install already installed extendsion', async () => {
                await testAddExtAlreadyIn(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        true,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                        value: toNano('1'),
                        body: reqMsg
                    });
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        from: owner.address,
                        op: Opcodes.auth_signed_internal,
                        aborted: true,
                        outMessagesCount: 1,
                        exitCode: ErrorsV5.add_extension
                    });
                    expect(await wallet.getSeqno()).toEqual(Number(args.seqno));
                });
            });
            it('should not be able to install extension from different chain', async () => {
                await loadFrom(hasMcWallet);
                await testAddExtWrongChain(
                    async args => {
                        const reqMsg = WalletV5Test.requestMessage(
                            true,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                            value: toNano('1'),
                            body: reqMsg
                        });
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            from: owner.address,
                            op: Opcodes.auth_signed_internal,
                            outMessagesCount: 1,
                            aborted: true,
                            exitCode: ErrorsV5.extension_wrong_workchain
                        });
                        expect(await wallet.getSeqno()).toEqual(Number(args.seqno));
                    },
                    async args => {
                        const reqMsg = WalletV5Test.requestMessage(
                            true,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await newWallet.sendInternalSignedMessage(owner.getSender(), {
                            value: toNano('1'),
                            body: reqMsg
                        });
                        expect(res.transactions).toHaveTransaction({
                            on: newWallet.address,
                            from: owner.address,
                            op: Opcodes.auth_signed_internal,
                            outMessagesCount: 0,
                            aborted: false
                        });
                        expect(await newWallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                    }
                );
            });
            it('should be able to remove extension', async () => {
                await testRemoveExt(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        true,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                        value: toNano('1'),
                        body: reqMsg
                    });

                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        from: owner.address,
                        op: Opcodes.auth_signed_internal,
                        outMessagesCount: 0,
                        aborted: false
                    });
                });
            });
            it('should throw on removing non-existent extension', async () => {
                await testRemoveExtNonExistent(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        true,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                        value: toNano('1'),
                        body: reqMsg
                    });
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        op: Opcodes.auth_signed_internal,
                        outMessagesCount: 1,
                        aborted: true,
                        exitCode: ErrorsV5.remove_extension
                    });
                    expect(await wallet.getSeqno()).toEqual(Number(args.seqno));
                });
            });
            it('should be able to add/remove extensions and send messages in one go', async () => {
                await testAddRemoveSend(async args => {
                    const reqMsg = WalletV5Test.requestMessage(
                        true,
                        args.walletId,
                        args.valid_until,
                        args.seqno,
                        args.actions,
                        args.key
                    );
                    const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                        value: toNano('1'),
                        body: reqMsg
                    });
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        op: Opcodes.auth_signed_internal,
                        aborted: false,
                        outMessagesCount: 255
                    });
                    expect(await wallet.getSeqno()).toEqual(Number(args.seqno) + 1);
                });
            });
            // describe('Bounce', () => {
            //     it('should ignore bounced mesages', async () => {
            //         await loadFrom(hasExtension);
            //         const seqNo = await wallet.getSeqno();
            //         const mockActions: WalletActions = { wallet: [message2action(mockMessage)] };
            //
            //         // Note that in reality bounce gets prefixed by 0xFFFFFFFF
            //         // With current code, that would mean message would be ignored
            //         // due to op check
            //         // However we still could test as if TVM doesn't add prefix to bounce somehow
            //         const intReq = WalletV5Test.requestMessage(
            //             true,
            //             walletId,
            //             curTime() + 1000,
            //             seqNo,
            //             mockActions,
            //             keys.secretKey
            //         );
            //         const extReq = WalletV5Test.extensionMessage(mockActions);
            //         // ihr_disable and bounce flags combinations
            //         let flagFuzz = [
            //             [false, false],
            //             [true, false],
            //             [false, true],
            //             [true, true]
            //         ];
            //
            //         const stateBefore = await getWalletData();
            //
            //         for (let flags of flagFuzz) {
            //             let res = await blockchain.sendMessage(
            //                 internal({
            //                     from: owner.address,
            //                     to: wallet.address,
            //                     body: intReq,
            //                     value: toNano('1'),
            //                     bounced: true,
            //                     ihrDisabled: flags[0],
            //                     bounce: flags[1]
            //                 })
            //             );
            //             expect(res.transactions).toHaveTransaction({
            //                 on: wallet.address,
            //                 op: Opcodes.auth_signed_internal,
            //                 aborted: false,
            //                 outMessagesCount: 0
            //             });
            //             expect(await getWalletData()).toEqualCell(stateBefore);
            //
            //             res = await blockchain.sendMessage(
            //                 internal({
            //                     from: testExtensionBc.address,
            //                     to: wallet.address,
            //                     body: extReq,
            //                     value: toNano('1'),
            //                     bounced: true,
            //                     ihrDisabled: flags[0],
            //                     bounce: flags[1]
            //                 })
            //             );
            //             expect(res.transactions).toHaveTransaction({
            //                 on: wallet.address,
            //                 op: Opcodes.auth_extension,
            //                 aborted: false,
            //                 outMessagesCount: 0
            //             });
            //             expect(await getWalletData()).toEqualCell(stateBefore);
            //         }
            //
            //         // Let's proove that bounce flag is the reason
            //         const resInt = await blockchain.sendMessage(
            //             internal({
            //                 from: owner.address,
            //                 to: wallet.address,
            //                 body: intReq,
            //                 value: toNano('1'),
            //                 ihrDisabled: true,
            //                 bounce: true
            //             })
            //         );
            //         assertMockMessage(resInt.transactions);
            //
            //         const resExt = await blockchain.sendMessage(
            //             internal({
            //                 from: testExtensionBc.address,
            //                 to: wallet.address,
            //                 body: extReq,
            //                 value: toNano('1'),
            //                 ihrDisabled: false,
            //                 bounce: false
            //             })
            //         );
            //         assertMockMessage(resExt.transactions);
            //     });
            // });
        });
        describe('Extension', () => {
            let actionFuzz: WalletActions[];
            beforeAll(async () => {
                actionFuzz = [
                    { wallet: [message2action(mockMessage)] },
                    { wallet: someMessages(10) },
                    { extended: someExtensions(5, 'add_extension') },
                    { wallet: someMessages(5), extended: someExtensions(5, 'add_extension') },
                    { extended: [{ type: 'remove_extension', address: testExtensionBc.address }] },
                    {
                        wallet: someMessages(5),
                        extended: [{ type: 'remove_extension', address: testExtensionBc.address }]
                    },
                    { extended: [{ type: 'sig_auth', allowed: false }] },
                    { wallet: someMessages(5), extended: [{ type: 'sig_auth', allowed: false }] }
                ];

                await loadFrom(hasExtension);
            });

            it('should be able to send message to arbitrary address', async () => {
                const msgValue = toNano(getRandomInt(1, 10));
                const randomBody = beginCell().storeUint(curTime(), 64).endCell();

                await assertSendMessages(
                    0,
                    walletId,
                    curTime() + 1000,
                    0,
                    [
                        {
                            message: internal_relaxed({
                                to: testWalletBc.address,
                                value: msgValue,
                                body: randomBody
                            }),
                            mode: SendMode.PAY_GAS_SEPARATELY
                        },
                        {
                            message: internal_relaxed({
                                to: testWalletMc.address,
                                value: msgValue,
                                body: randomBody
                            }),
                            mode: SendMode.PAY_GAS_SEPARATELY
                        }
                    ],
                    keys.secretKey,
                    extensionSender
                );
            });
            it('extension action is only allowed from installed extension address', async () => {
                const differentExt = await blockchain.treasury('Not installed');

                const stateBefore = await getWalletData();

                for (let testSender of [owner, differentExt]) {
                    for (let actions of actionFuzz) {
                        const res = await wallet.sendExtensionActions(
                            testSender.getSender(),
                            actions
                        );
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            from: testSender.address,
                            op: Opcodes.auth_extension,
                            aborted: false,
                            outMessagesCount: 0
                        });
                        expect(await getWalletData()).toEqualCell(stateBefore);
                    }
                }

                const res = await wallet.sendExtensionActions(
                    testExtensionBc.getSender(),
                    actionFuzz[0]
                );

                assertMockMessage(res.transactions);
                expect(await getWalletData()).toEqualCell(stateBefore);
            });
            it('extension request with same hash from different workchain should be ignored', async () => {
                // Those should completely equal by hash
                expect(testExtensionBc.address.hash.equals(testExtensionMc.address.hash)).toBe(
                    true
                );

                // Extension with such has is installed
                const curExt = await wallet.getExtensionsArray();
                expect(
                    curExt.findIndex(e => e.hash.equals(testExtensionMc.address.hash))
                ).toBeGreaterThanOrEqual(0);

                const stateBefore = await getWalletData();

                for (let actions of actionFuzz) {
                    const res = await wallet.sendExtensionActions(
                        testExtensionMc.getSender(),
                        actions
                    );
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        from: testExtensionMc.address,
                        op: Opcodes.auth_extension,
                        aborted: false,
                        outMessagesCount: 0
                    });
                    expect(await getWalletData()).toEqualCell(stateBefore);
                }
            });
            it('should be able to send up to 255 messages', async () => {
                let testMsgs: MessageOut[] = new Array(255);
                const seqNo = BigInt(await wallet.getSeqno());

                for (let i = 0; i < 255; i++) {
                    testMsgs[i] = {
                        message: internal_relaxed({
                            to: testWalletBc.address,
                            value: toNano('1'),
                            body: beginCell().storeUint(i, 32).endCell()
                        }),
                        mode: defaultExternalMode
                    };
                }
                await assertSendMessages(
                    0,
                    walletId,
                    curTime() + 1000,
                    seqNo,
                    testMsgs,
                    keys.secretKey,
                    extensionSender
                );
            });
            it('should be able to send messages with various send modes', async () => {
                let modeSet = [
                    SendMode.NONE,
                    SendMode.PAY_GAS_SEPARATELY,
                    SendMode.CARRY_ALL_REMAINING_INCOMING_VALUE,
                    SendMode.CARRY_ALL_REMAINING_BALANCE
                ];
                await testSendModes(true, 0, SendMode.IGNORE_ERRORS, modeSet, extensionSender);
                // And without IGNORE_ERRORS
                await testSendModes(true, 0, 0, modeSet, extensionSender);
            });
            it('should be able to send message with init state', async () => {
                await testSendInit(
                    async args => {
                        if (!Address.isAddress(args.extra.new_address)) {
                            throw new TypeError('Callback requires wallet address');
                        }
                        const reqMsg = WalletV5Test.requestMessage(
                            true,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const res = await wallet.sendExtensionActions(
                            testExtensionBc.getSender(),
                            args.actions
                        );

                        expect(res.transactions).toHaveTransaction({
                            on: args.extra.new_address,
                            aborted: false,
                            deploy: true
                        });
                    },
                    async args => {
                        // Couldn't think of any better
                        const reqMsg = WalletV5Test.requestMessage(
                            true,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            {
                                wallet: [message2action(mockMessage)]
                            },
                            args.key
                        );

                        const testMsg = internal_relaxed({
                            to: newWallet.address,
                            value: toNano('2'),
                            body: reqMsg
                        });

                        const res = await wallet.sendExtensionActions(testExtensionBc.getSender(), {
                            wallet: [
                                {
                                    type: 'sendMsg',
                                    mode: SendMode.PAY_GAS_SEPARATELY,
                                    outMsg: testMsg
                                }
                            ]
                        });

                        // So tx chain ext->basechain wallet->mc wallet->mock message
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            from: testExtensionBc.address,
                            op: Opcodes.auth_extension,
                            aborted: false,
                            outMessagesCount: 1
                        });
                        expect(res.transactions).toHaveTransaction({
                            on: newWallet.address,
                            from: wallet.address,
                            op: Opcodes.auth_signed_internal,
                            aborted: false,
                            outMessagesCount: 1
                        });
                        // Finally mock messages goes live
                        assertMockMessage(res.transactions, newWallet.address);
                    }
                );
            });
            it('should be able to send external message', async () => {
                const testPayload = BigInt(getRandomInt(0, 100000));
                const testBody = beginCell().storeUint(testPayload, 32).endCell();

                const res = await wallet.sendExtensionActions(testExtensionBc.getSender(), {
                    wallet: [
                        {
                            type: 'sendMsg',
                            mode: SendMode.NONE,
                            outMsg: {
                                info: {
                                    type: 'external-out',
                                    createdAt: 0,
                                    createdLt: 0n,
                                    dest: new ExternalAddress(testPayload, 32),
                                    src: null
                                },
                                body: testBody
                            }
                        }
                    ]
                });

                const txSuccess = findTransactionRequired(res.transactions, {
                    on: wallet.address,
                    from: testExtensionBc.address,
                    op: Opcodes.auth_extension,
                    aborted: false
                });

                expect(txSuccess.externals.length).toBe(1);

                const extOut = txSuccess.externals[0];

                expect(extOut.info.dest!.value).toBe(testPayload);
                expect(extOut.body).toEqualCell(testBody);
            });
            it('should bounce set_code action', async () => {
                await testSetCode(
                    async args => {
                        const res = await wallet.sendExtensionActions(
                            testExtensionBc.getSender(),
                            args.actions
                        );
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            op: Opcodes.auth_extension,
                            outMessagesCount: 1, // bounce
                            aborted: true,
                            success: false, // No commit anymore
                            exitCode: 9
                        });
                        expect(await wallet.getSeqno()).toEqual(Number(args.seqno)); // On internal seqno is not commited
                    },
                    async args => {
                        const res = await wallet.sendExtensionActions(
                            testExtensionBc.getSender(),
                            args.actions
                        );
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            from: testExtensionBc.address,
                            op: Opcodes.auth_extension,
                            aborted: false,
                            outMessagesCount: 254,
                            exitCode: 0
                        });
                    }
                );
            });
            it('should be able to add extension', async () => {
                const randomExtAddres = randomAddress();
                await testAddExt(async args => {
                    const res = await wallet.sendExtensionActions(
                        testExtensionBc.getSender(),
                        args.actions
                    );
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        from: testExtensionBc.address,
                        op: Opcodes.auth_extension,
                        outMessagesCount: 0,
                        aborted: false,
                        exitCode: 0
                    });
                }, randomExtAddres);
            });
            it('should not be able to install already installed extendsion', async () => {
                await testAddExtAlreadyIn(async args => {
                    const res = await wallet.sendExtensionActions(
                        testExtensionBc.getSender(),
                        args.actions
                    );
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        from: testExtensionBc.address,
                        op: Opcodes.auth_extension,
                        aborted: true,
                        outMessagesCount: 1,
                        exitCode: ErrorsV5.add_extension
                    });
                });
            });
            it('should not be able to install extension from different chain', async () => {
                await loadFrom(hasMcWallet);
                await testAddExtWrongChain(
                    async args => {
                        const res = await wallet.sendExtensionActions(
                            testExtensionBc.getSender(),
                            args.actions,
                            toNano('1')
                        );
                        expect(res.transactions).toHaveTransaction({
                            on: wallet.address,
                            from: testExtensionBc.address,
                            op: Opcodes.auth_extension,
                            outMessagesCount: 1,
                            aborted: true,
                            exitCode: ErrorsV5.extension_wrong_workchain
                        });
                    },
                    async args => {
                        const reqMsg = WalletV5Test.requestMessage(
                            true,
                            args.walletId,
                            args.valid_until,
                            args.seqno,
                            args.actions,
                            args.key
                        );
                        const testMsg = internal_relaxed({
                            to: newWallet.address,
                            value: toNano('2'),
                            body: reqMsg
                        });

                        const res = await wallet.sendExtensionActions(testExtensionBc.getSender(), {
                            wallet: [
                                {
                                    type: 'sendMsg',
                                    mode: SendMode.PAY_GAS_SEPARATELY,
                                    outMsg: testMsg
                                }
                            ]
                        });
                        // So via extension we've sent signed add_extension message
                        // through our wallet to the masterchain wallet
                        // And it should end up being installed
                        expect(res.transactions).toHaveTransaction({
                            on: newWallet.address,
                            from: wallet.address,
                            op: Opcodes.auth_signed_internal,
                            outMessagesCount: 0,
                            aborted: false
                        });
                    }
                );
            });
            it('should be able to remove extension', async () => {
                await testRemoveExt(async args => {
                    const res = await wallet.sendExtensionActions(
                        testExtensionBc.getSender(),
                        args.actions,
                        toNano('1')
                    );

                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        from: testExtensionBc.address,
                        op: Opcodes.auth_extension,
                        outMessagesCount: 0,
                        aborted: false
                    });
                });
            });
            it('should throw on removing non-existent extension', async () => {
                await testRemoveExtNonExistent(async args => {
                    const res = await wallet.sendExtensionActions(
                        testExtensionBc.getSender(),
                        args.actions
                    );
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        from: testExtensionBc.address,
                        op: Opcodes.auth_extension,
                        outMessagesCount: 1,
                        aborted: true,
                        exitCode: ErrorsV5.remove_extension
                    });
                });
            });
            it('should be able to add/remove extensions and send messages in one go', async () => {
                await testAddRemoveSend(async args => {
                    const res = await wallet.sendExtensionActions(
                        testExtensionBc.getSender(),
                        args.actions,
                        toNano('1')
                    );
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        from: testExtensionBc.address,
                        op: Opcodes.auth_extension,
                        aborted: false,
                        outMessagesCount: 255
                    });
                });
            });
        });
        describe('Malformed action list', () => {
            it('action list exceeding 255 elements should be rejected', async () => {
                await loadFrom(hasExtension);
                let seqNo = await wallet.getSeqno();
                let tooMuch = someMessages(256);
                const extReq = WalletV5Test.requestMessage(
                    false,
                    walletId,
                    curTime() + 100,
                    seqNo,
                    { wallet: tooMuch },
                    keys.secretKey
                );

                let res = await wallet.sendExternalSignedMessage(extReq);
                expect(res.transactions).toHaveTransaction({
                    on: wallet.address,
                    op: Opcodes.auth_signed,
                    outMessagesCount: 0,
                    exitCode: ErrorsV5.invalid_c5
                });
                expect(await wallet.getSeqno()).toEqual(++seqNo);

                const intReq = WalletV5Test.requestMessage(
                    true,
                    walletId,
                    curTime() + 100,
                    seqNo,
                    { wallet: tooMuch },
                    keys.secretKey
                );
                res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                    value: toNano('1'),
                    body: intReq
                });

                expect(res.transactions).toHaveTransaction({
                    on: wallet.address,
                    op: Opcodes.auth_signed_internal,
                    aborted: true,
                    outMessagesCount: 1,
                    exitCode: ErrorsV5.invalid_c5
                });

                res = await wallet.sendExtensionActions(
                    testExtensionBc.getSender(),
                    { wallet: tooMuch },
                    toNano('1')
                );

                expect(res.transactions).toHaveTransaction({
                    on: wallet.address,
                    op: Opcodes.auth_extension,
                    aborted: true,
                    outMessagesCount: 1,
                    exitCode: ErrorsV5.invalid_c5
                });
            });
            it('should reject action list with extra data/refs', async () => {
                let seqNo = await wallet.getSeqno();
                const testActionRaw = beginCell().store(
                    storeOutAction({
                        type: 'sendMsg',
                        mode: SendMode.PAY_GAS_SEPARATELY,
                        outMsg: mockMessage.message
                    })
                );

                const ds = testActionRaw.asSlice();
                ds.loadRef(); // Drop one
                const noRef = beginCell().storeSlice(ds).endCell();
                const excessiveData = beginCell()
                    .storeSlice(testActionRaw.asSlice())
                    .storeBit(true)
                    .endCell();
                const truncated = beginCell()
                    .storeBits(testActionRaw.asSlice().loadBits(testActionRaw.bits - 1))
                    .endCell();
                const extraRef = beginCell()
                    .storeSlice(testActionRaw.asSlice())
                    .storeRef(beginCell().storeUint(0x0ec3c86d, 32).endCell())
                    .endCell();

                const origActions = beginCell()
                    .storeRef(beginCell().endCell())
                    .storeSlice(testActionRaw.asSlice())
                    .endCell();

                for (let payload of [excessiveData, truncated, extraRef, noRef]) {
                    const actionList = beginCell()
                        .storeRef(beginCell().endCell())
                        .storeSlice(payload.asSlice())
                        .endCell();

                    const intReq = WalletV5Test.requestMessage(
                        true,
                        walletId,
                        curTime() + 100,
                        seqNo,
                        { wallet: actionList },
                        keys.secretKey
                    );
                    let res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                        value: toNano('1'),
                        body: intReq
                    });

                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        op: Opcodes.auth_signed_internal,
                        aborted: true,
                        outMessagesCount: 1,
                        exitCode: ErrorsV5.invalid_c5
                    });

                    const extReq = WalletV5Test.requestMessage(
                        false,
                        walletId,
                        curTime() + 100,
                        seqNo,
                        { wallet: actionList },
                        keys.secretKey
                    );
                    res = await wallet.sendExternalSignedMessage(extReq);
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        op: Opcodes.auth_signed,
                        aborted: false,
                        outMessagesCount: 0,
                        exitCode: ErrorsV5.invalid_c5
                    });
                    expect(await wallet.getSeqno()).toEqual(++seqNo);

                    res = await wallet.sendExtensionActions(
                        testExtensionBc.getSender(),
                        { wallet: actionList },
                        toNano('1')
                    );
                    expect(res.transactions).toHaveTransaction({
                        on: wallet.address,
                        op: Opcodes.auth_extension,
                        aborted: true,
                        outMessagesCount: 1,
                        exitCode: ErrorsV5.invalid_c5
                    });
                }

                const intReq = WalletV5Test.requestMessage(
                    true,
                    walletId,
                    curTime() + 100,
                    seqNo,
                    { wallet: origActions },
                    keys.secretKey
                );
                const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                    value: toNano('1'),
                    body: intReq
                });
                assertMockMessage(res.transactions);
            });
        });
    });
    describe('Signature auth', () => {
        type OwnerArguments = { walletId: bigint; seqno: number | bigint; key: Buffer };
        let signatureDisabled: BlockchainSnapshot;
        let signatureEnabled: BlockchainSnapshot;
        let multipleExtensions: BlockchainSnapshot;
        /*
        let testRemoveExtension: (exp: number,
                                  reqType:RequestType,
                                  extension: Address,
                                  via: Sender, commonArgs: OwnerArguments) => Promise<SendMessageResult>;
        */
        beforeAll(async () => {
            await loadFrom(hasExtension);
        });

        it('extension should be able to set signature mode', async () => {
            const seqNo = await wallet.getSeqno();
            const allowedBefore = await wallet.getIsSignatureAuthAllowed();
            expect(allowedBefore).toBe(-1);
            signatureEnabled = blockchain.snapshot();

            let res = await wallet.sendExtensionActions(testExtensionBc.getSender(), {
                extended: [
                    {
                        type: 'sig_auth',
                        allowed: false
                    }
                ]
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: testExtensionBc.address,
                op: Opcodes.auth_extension,
                aborted: false
            });
            expect(await wallet.getIsSignatureAuthAllowed()).toBe(0);
            expect(await wallet.getSeqno()).toEqual(seqNo);
            signatureDisabled = blockchain.snapshot();

            res = await wallet.sendExtensionActions(testExtensionBc.getSender(), {
                extended: [
                    {
                        type: 'sig_auth',
                        allowed: true
                    }
                ]
            });
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: testExtensionBc.address,
                op: Opcodes.auth_extension,
                aborted: false
            });
            expect(await wallet.getIsSignatureAuthAllowed()).toBe(-1);
            expect(await wallet.getSeqno()).toEqual(seqNo);
            signatureEnabled = blockchain.snapshot(); // Usefull?
        });
        it('should reject atempt to change sig auth via internal/external request', async () => {
            let seqNo = await wallet.getSeqno();

            const disableSigAuth: ExtendedAction = {
                type: 'sig_auth',
                allowed: false
            };
            const enableSigAuth: ExtendedAction = {
                type: 'sig_auth',
                allowed: true
            };

            const mockExtensions = someExtensions(100, 'add_extension');
            const randIdx = getRandomInt(0, mockExtensions.length - 2);

            /*
            const msgInt = WalletV5Test.requestMessage(true, walletId, curTime() + 100, seqNo, testWalletAction, keys.secretKey);
            const msgExt = WalletV5Test.requestMessage(false, walletId, curTime() + 100, seqNo, testWalletAction, keys.secretKey);
            */

            //const res = await  wallet.sendExtensionActions(testExtensionBc.getSender(), testWalletActions);

            // const fromInt = async (message) => await wallet.sendInternalSignedMessage(owner.getSender(), {value: toNano('1'), body: message});
            // const fromExt = async (message) => await wallet.sendExternalSignedMessage(message);

            for (let action of [disableSigAuth, enableSigAuth]) {
                const actionSingle = [action];
                const actionFirst = [action, ...mockExtensions];
                const actionLast = [...mockExtensions, action];
                const actionRandom = [...mockExtensions];
                actionRandom[randIdx] = action;

                for (let actionSet of [actionSingle, actionFirst, actionLast, actionRandom]) {
                    const msgInt = WalletV5Test.requestMessage(
                        true,
                        walletId,
                        curTime() + 100,
                        seqNo,
                        { extended: actionSet },
                        keys.secretKey
                    );
                    const msgExt = WalletV5Test.requestMessage(
                        false,
                        walletId,
                        curTime() + 100,
                        seqNo,
                        { extended: actionSet },
                        keys.secretKey
                    );
                    // Meh, kinda much
                    for (let testMsg of [msgInt, msgExt]) {
                        if (testMsg == msgInt) {
                            const stateBefore = await getWalletData();
                            const res = await wallet.sendInternalSignedMessage(owner.getSender(), {
                                value: toNano('1'),
                                body: msgInt
                            });
                            expect(res.transactions).toHaveTransaction({
                                on: wallet.address,
                                aborted: true,
                                exitCode: ErrorsV5.only_extension_can_change_signature_mode
                            });
                            expect(await getWalletData()).toEqualCell(stateBefore);
                        } else {
                            const res = await wallet.sendExternalSignedMessage(msgExt);
                            expect(res.transactions).toHaveTransaction({
                                on: wallet.address,
                                aborted: false,
                                exitCode: ErrorsV5.only_extension_can_change_signature_mode
                            });
                            expect(await wallet.getSeqno()).toEqual(++seqNo);
                        }
                    }
                }
            }
        });
        it('should reject sig auth if mode is already set', async () => {
            let i = 0;
            for (let testState of [signatureDisabled, signatureEnabled]) {
                await loadFrom(testState);
                let stateBefore = await getWalletData();
                let res = await wallet.sendExtensionActions(testExtensionBc.getSender(), {
                    extended: [
                        {
                            type: 'sig_auth',
                            allowed: Boolean(i++)
                        }
                    ]
                });
                expect(res.transactions).toHaveTransaction({
                    on: wallet.address,
                    from: testExtensionBc.address,
                    op: Opcodes.auth_extension,
                    aborted: true,
                    exitCode: ErrorsV5.this_signature_mode_already_set
                });
                expect(await getWalletData()).toEqualCell(stateBefore);
            }
        });
        it('should not accept signed external when signature auth is disabled and extension present', async () => {
            await loadFrom(signatureDisabled);
            const seqNo = await wallet.getSeqno();
            await shouldRejectWith(
                wallet.sendMessagesExternal(walletId, curTime() + 100, seqNo, keys.secretKey, [
                    mockMessage
                ]),
                ErrorsV5.signature_disabled
            );
            expect(await wallet.getSeqno()).toEqual(seqNo);
        });
        it('should not accept signed internal when signature auth is disabled and exension is present', async () => {
            await loadFrom(signatureDisabled);
            const seqNo = await wallet.getSeqno();
            await assertSendMessages(
                ErrorsV5.signature_disabled,
                walletId,
                curTime() + 100,
                seqNo,
                [mockMessage],
                keys.secretKey,
                owner.getSender()
            );
        });
        it('extension should be able to add another extension when sig auth is disabled', async () => {
            await loadFrom(signatureDisabled);
            const testExtAddr = randomAddress();
            const stateBefore = await getWalletData();
            const extBefore = await wallet.getExtensionsArray();
            expect(extBefore.length).toBe(1);

            const res = await wallet.sendExtensionActions(testExtensionBc.getSender(), {
                extended: [{ type: 'add_extension', address: testExtAddr }]
            });
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: testExtensionBc.address,
                op: Opcodes.auth_extension,
                aborted: false
            });

            const extAfter = await wallet.getExtensionsArray();
            expect(extAfter.length).toBe(2);
            expect(extAfter.findIndex(a => a.equals(testExtAddr))).toBeGreaterThanOrEqual(0);

            multipleExtensions = blockchain.snapshot();
        });
        it('should not allow to remove last extension when sig auth is disabled', async () => {
            await loadFrom(signatureDisabled);

            const stateBefore = await getWalletData();
            const extBefore = await wallet.getExtensionsArray();
            expect(extBefore.length).toBe(1);

            let res = await wallet.sendExtensionActions(testExtensionBc.getSender(), {
                extended: [
                    {
                        type: 'remove_extension',
                        address: extBefore[0]
                    }
                ]
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: testExtensionBc.address,
                op: Opcodes.auth_extension,
                aborted: true,
                exitCode: ErrorsV5.remove_last_extension_when_signature_disabled
            });
            expect(await getWalletData()).toEqualCell(stateBefore);
        });
        it('should remove extension if sig auth disabled and at lease one left', async () => {
            await loadFrom(multipleExtensions);

            const extBefore = await wallet.getExtensionsArray();
            expect(extBefore.length).toBeGreaterThan(1);

            const pickExt = extBefore[getRandomInt(0, extBefore.length - 1)];

            const res = await wallet.sendExtensionActions(testExtensionBc.getSender(), {
                extended: [{ type: 'remove_extension', address: pickExt }]
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: testExtensionBc.address,
                op: Opcodes.auth_extension,
                aborted: false
            });

            const extAfter = await wallet.getExtensionsArray();
            expect(extAfter.length).toBe(extBefore.length - 1);
            expect(extAfter.findIndex(a => a.equals(pickExt))).toBe(-1);
        });
        it('should not allow to remove last extension and then disable sig auth', async () => {
            await loadFrom(signatureEnabled);
            const stateBefore = await getWalletData();
            const testWalletActions: WalletActions = {
                extended: [
                    { type: 'remove_extension', address: testExtensionBc.address },
                    { type: 'sig_auth', allowed: false }
                ]
            };

            const res = await wallet.sendExtensionActions(
                testExtensionBc.getSender(),
                testWalletActions
            );

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                aborted: true,
                exitCode: ErrorsV5.disable_signature_when_extensions_is_empty
            });

            expect(await getWalletData()).toEqualCell(stateBefore);
        });
    });
});
