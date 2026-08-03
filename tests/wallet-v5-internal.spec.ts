import {Blockchain, BlockchainTransaction, SandboxContract} from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, Sender, SendMode, toNano } from '@ton/core';
import { Opcodes, WalletId, WalletV5 } from '../wrappers/wallet-v5';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed, sign } from 'ton-crypto';
import { bufferToBigInt, createMsgInternal, disableConsoleError, packAddress, validUntil } from './utils';
import {
    ActionAddExtension,
    ActionRemoveExtension,
    ActionSendMsg, ActionSetSignatureAuthAllowed,
    packActionsList
} from './actions';
import { TransactionDescriptionGeneric } from '@ton/core/src/types/TransactionDescription';
import { TransactionComputeVm } from '@ton/core/src/types/TransactionComputePhase';
import { buildBlockchainLibraries, LibraryDeployer } from '../wrappers/library-deployer';
import { default as config } from './config';
import { ActionSetCode, ActionSetData } from './test-only-actions';

const WALLET_ID = new WalletId({ networkGlobalId: -239, workChain: 0, subwalletNumber: 0 });

describe('Wallet V5 sign auth internal', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('wallet_v5');
    });

    let blockchain: Blockchain;
    let walletV5: SandboxContract<WalletV5>;
    let keypair: KeyPair;
    let sender: Sender;
    let seqno: number;

    let ggc: bigint = BigInt(0);
    function accountForGas(transactions: BlockchainTransaction[]) {
        transactions.forEach((tx) => {
            ggc += ((tx?.description as TransactionDescriptionGeneric)?.computePhase as TransactionComputeVm)?.gasUsed ?? BigInt(0);
        })
    }

    afterAll(async() => {
        console.log("INTERNAL TESTS: Total gas " + ggc);
    });

    async function deployOtherWallet(
        params?: Partial<Parameters<typeof WalletV5.createFromConfig>[0]>
    ) {
        const _keypair = keyPairFromSeed(await getSecureRandomBytes(32));

        const _walletV5 = blockchain.openContract(
            WalletV5.createFromConfig(
                {
                    signatureAllowed: true,
                    seqno: params?.seqno ?? 0,
                    walletId: params?.walletId ?? WALLET_ID.serialized,
                    publicKey: params?.publicKey ?? _keypair.publicKey,
                    extensions: params?.extensions ?? Dictionary.empty()
                },
                LibraryDeployer.exportLibCode(code)
            )
        );

        const deployer = await blockchain.treasury('deployer');
        const _sender = deployer.getSender();

        const deployResult = await _walletV5.sendDeploy(_sender, toNano('0.05'));
        return { sender: _sender, walletV5: _walletV5, keypair: _keypair, deployer, deployResult };
    }

    function createBody(actionsList: Cell) {
        const payload = beginCell()
            .storeUint(Opcodes.auth_signed_internal, 32)
            .storeUint(WALLET_ID.serialized, 32)
            .storeUint(validUntil(), 32)
            .storeUint(seqno, 32) // seqno
            .storeSlice(actionsList.beginParse())
            .endCell();

        const signature = sign(payload.hash(), keypair.secretKey);
        seqno++;
        return beginCell()
            .storeSlice(payload.beginParse())
            .storeUint(bufferToBigInt(signature), 512)
            .endCell();
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.libs = buildBlockchainLibraries([code]);

        keypair = keyPairFromSeed(await getSecureRandomBytes(32));

        walletV5 = blockchain.openContract(
            WalletV5.createFromConfig(
                {
                    signatureAllowed: true,
                    seqno: 0,
                    walletId: WALLET_ID.serialized,
                    publicKey: keypair.publicKey,
                    extensions: Dictionary.empty()
                },
                LibraryDeployer.exportLibCode(code)
            )
        );

        const deployer = await blockchain.treasury('deployer');
        sender = deployer.getSender();

        const deployResult = await walletV5.sendDeploy(sender, toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: walletV5.address,
            deploy: true,
            success: true
        });

        seqno = 0;
    });

    it('Send a simple transfer', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;

        const sendTxMsg = beginCell()
            .storeUint(0x10, 6)
            .storeAddress(testReceiver)
            .storeCoins(forwardValue)
            .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
            .storeRef(beginCell().endCell())
            .endCell();

        const sendTxactionAction = beginCell()
            .storeUint(Opcodes.action_send_msg, 32)
            .storeInt(SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS, 8)
            .storeRef(sendTxMsg)
            .endCell();

        const actionsList = beginCell()
            .storeMaybeRef(
                beginCell()
                    .storeRef(beginCell().endCell())
                    .storeSlice(sendTxactionAction.beginParse())
                    .endCell()
            )
            .storeUint(0, 1) // no other actions
            .endCell();

        if (config.microscope)
            blockchain.verbosity = { ...blockchain.verbosity, blockchainLogs: true, vmLogs: 'vm_logs_gas', debugLogs: true, print: true }

        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList)
        });

        if (config.microscope)
            blockchain.verbosity = { ...blockchain.verbosity, blockchainLogs: false, vmLogs: 'none', debugLogs: false, print: false }

        expect(receipt.transactions.length).toEqual(3);
        accountForGas(receipt.transactions);

        expect(receipt.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const fee = receipt.transactions[2].totalFees.coins;
        console.debug(
            'SINGLE INTERNAL TRANSFER GAS USED:',
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).gasUsed
        );

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);
    });

    it('Add an extension', async () => {
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');

        const addExtensionAction = beginCell()
            .storeUint(Opcodes.action_extended_add_extension, 8)
            .storeAddress(testExtension)
            .endCell();

        const actionsList = beginCell()
            .storeUint(0, 1) // no c5 actions
            .storeUint(1, 1)
            .storeSlice(addExtensionAction.beginParse())
            .endCell();

        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList)
        });

        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);

        const extensions = await walletV5.getExtensions();
        const extensionsDict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            extensions
        );

        expect(extensionsDict.size).toEqual(1);

        const storedWC = extensionsDict.get(packAddress(testExtension));
        expect(storedWC).toEqual(-1n);
    });

    it('Send two transfers', async () => {
        const testReceiver1 = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue1 = toNano(0.001);

        const { walletV5: testReceiver2Wallet } = await deployOtherWallet();

        const testReceiver2 = testReceiver2Wallet.address;
        const forwardValue2 = toNano(0.002);

        const receiver1BalanceBefore = (await blockchain.getContract(testReceiver1)).balance;
        const receiver2BalanceBefore = (await blockchain.getContract(testReceiver2)).balance;

        const msg1 = createMsgInternal({ dest: testReceiver1, value: forwardValue1 });
        const msg2 = createMsgInternal({ dest: testReceiver2, value: forwardValue2, bounce: true });

        const actionsList = packActionsList([
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg1),
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg2)
        ]);

        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList)
        });

        expect(receipt.transactions.length).toEqual(4);
        accountForGas(receipt.transactions);

        expect(receipt.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver1,
            value: forwardValue1
        });

        expect(receipt.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver2,
            value: forwardValue2
        });

        const fee1 = receipt.transactions[2].totalFees.coins;
        const fee2 = receipt.transactions[3].totalFees.coins;

        const receiver1BalanceAfter = (await blockchain.getContract(testReceiver1)).balance;
        const receiver2BalanceAfter = (await blockchain.getContract(testReceiver2)).balance;

        expect(receiver1BalanceAfter).toEqual(receiver1BalanceBefore + forwardValue1 - fee1);
        expect(receiver2BalanceAfter).toEqual(receiver2BalanceBefore + forwardValue2 - fee2);
    });

    it('Add two extensions and do a transfer', async () => {
        const testExtension1 = Address.parse('EQA2pT4d8T7TyRsjW2BpGpGYga-lMA4JjQb4D2tc1PXMX5Bf');
        const testExtension2 = Address.parse('EQCgYDKqfTh7zVj9BQwOIPs4SuOhM7wnIjb6bdtM2AJf_Z9G');

        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;

        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });

        const actionsList = packActionsList([
            new ActionAddExtension(testExtension1),
            new ActionAddExtension(testExtension2),
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)
        ]);

        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList)
        });

        expect(receipt.transactions.length).toEqual(3);
        accountForGas(receipt.transactions);

        expect(receipt.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const fee = receipt.transactions[2].totalFees.coins;
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);

        const extensionsDict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );

        expect(extensionsDict.size).toEqual(2);

        expect(extensionsDict.get(packAddress(testExtension1))).toEqual(
            -1n
        );
        expect(extensionsDict.get(packAddress(testExtension2))).toEqual(
            -1n
        );
    });

    it('Remove extension', async () => {
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');

        const actionsList1 = packActionsList([new ActionAddExtension(testExtension)]);
        const receipt1 = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList1)
        });
        const extensionsDict1 = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );
        expect(extensionsDict1.size).toEqual(1);
        expect(extensionsDict1.get(packAddress(testExtension))).toEqual(
            -1n
        );

        const actionsList2 = packActionsList([new ActionRemoveExtension(testExtension)]);
        const receipt2 = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList2)
        });
        const extensionsDict2 = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );

        expect(extensionsDict2.size).toEqual(0);
        expect(extensionsDict2.get(packAddress(testExtension))).toEqual(undefined);

        accountForGas(receipt1.transactions);
        accountForGas(receipt2.transactions);
    });

    it('Should fail SetData action', async () => {
        const cell = beginCell().endCell();

        const actionsList = packActionsList([
            new ActionSetData(cell)
        ]);
        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList)
        });

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(141);
    });

    it('Should fail SetCode action', async () => {
        const cell = beginCell().endCell();

        const actionsList = packActionsList([
            new ActionSetCode(cell)
        ]);
        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList)
        });

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(9);
    });

    it('Should fail adding existing extension', async () => {
        const testExtension = Address.parseRaw('0:' + '0'.repeat(64));

        const actionsList1 = packActionsList([new ActionAddExtension(testExtension)]);
        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList1)
        });
        const extensionsDict1 = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );
        expect(extensionsDict1.size).toEqual(1);
        expect(extensionsDict1.get(packAddress(testExtension))).toEqual(
            -1n
        );

        const actionsList2 = packActionsList([new ActionAddExtension(testExtension)]);
        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList2)
        });

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(139);

        const extensionsDict2 = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );
        expect(extensionsDict2.size).toEqual(1);
        expect(extensionsDict2.get(packAddress(testExtension))).toEqual(
            -1n
        );
    });

    it('Should fail removing not existing extension', async () => {
        const testExtension = Address.parseRaw('0:' + '0'.repeat(64));

        const actionsList = packActionsList([new ActionRemoveExtension(testExtension)]);
        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList)
        });

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(140);

        const extensionsDict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );
        expect(extensionsDict.size).toEqual(0);
        expect(extensionsDict.get(packAddress(testExtension))).toEqual(undefined);
    });

    it('Should fail if signature is invalid: wrong payload signed', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        const vu = validUntil();

        const payload = beginCell()
            .storeUint(Opcodes.auth_signed_internal, 32)
            .storeUint(WALLET_ID.serialized, 32)
            .storeUint(vu, 32)
            .storeUint(seqno, 32) // seqno
            .storeSlice(actionsList.beginParse())
            .endCell();

        const fakePayload = beginCell()
            .storeUint(WALLET_ID.serialized, 32)
            .storeUint(vu, 32)
            .storeUint(seqno + 1, 32) // seqno
            .storeSlice(actionsList.beginParse())
            .endCell();

        const signature = sign(fakePayload.hash(), keypair.secretKey);
        const body = beginCell()
            .storeSlice(payload.beginParse())
            .storeUint(bufferToBigInt(signature), 512)
            .endCell();

        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body
        });

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        expect(receipt.transactions).not.toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;

        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should fail if signature is invalid: wrong private key used', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        const payload = beginCell()
            .storeUint(Opcodes.auth_signed_internal, 32)
            .storeUint(WALLET_ID.serialized, 32)
            .storeUint(validUntil(), 32)
            .storeUint(seqno, 32) // seqno
            .storeSlice(actionsList.beginParse())
            .endCell();

        const fakeKeypair = keyPairFromSeed(await getSecureRandomBytes(32));

        const signature = sign(payload.hash(), fakeKeypair.secretKey);
        const body = beginCell()
            .storeSlice(payload.beginParse())
            .storeUint(bufferToBigInt(signature), 512)
            .endCell();

        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body
        });
        console.debug(
            'SINGLE WRONG SIGNATURE INTERNAL TRANSFER GAS USED:',
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).gasUsed
        );

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        expect(receipt.transactions).not.toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;

        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should fail if seqno is invalid', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        const payload = beginCell()
            .storeUint(Opcodes.auth_signed_internal, 32)
            .storeUint(WALLET_ID.serialized, 32)
            .storeUint(validUntil(), 32)
            .storeUint(seqno + 1, 32) // seqno
            .storeSlice(actionsList.beginParse())
            .endCell();

        const signature = sign(payload.hash(), keypair.secretKey);
        const body = beginCell()
            .storeSlice(payload.beginParse())
            .storeUint(bufferToBigInt(signature), 512)
            .endCell();

        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body
        });

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(133);

        expect(receipt.transactions).not.toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;

        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should fail if valid_until is expired', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        const payload = beginCell()
            .storeUint(Opcodes.auth_signed_internal, 32)
            .storeUint(WALLET_ID.serialized, 32)
            .storeUint(Math.round(Date.now() / 1000) - 600, 32)
            .storeUint(seqno, 32)
            .storeSlice(actionsList.beginParse())
            .endCell();

        const signature = sign(payload.hash(), keypair.secretKey);
        const body = beginCell()
            .storeSlice(payload.beginParse())
            .storeUint(bufferToBigInt(signature), 512)
            .endCell();

        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body
        });

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(136);

        expect(receipt.transactions).not.toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;

        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should fail if subwallet id is wrong', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        const payload = beginCell()
            .storeUint(Opcodes.auth_signed_internal, 32)
            .storeUint(new WalletId({ ...WALLET_ID, subwalletNumber: 1 }).serialized, 32)
            .storeUint(validUntil(), 32)
            .storeUint(seqno, 32)
            .storeSlice(actionsList.beginParse())
            .endCell();

        const signature = sign(payload.hash(), keypair.secretKey);
        const body = beginCell()
            .storeSlice(payload.beginParse())
            .storeUint(bufferToBigInt(signature), 512)
            .endCell();

        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body
        });

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(134);

        expect(receipt.transactions).not.toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;

        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should skip message if auth kind is wrong', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        const payload = beginCell() // auth_signed used instead of auth_signed_internal
            .storeUint(Opcodes.auth_signed, 32)
            .storeUint(WALLET_ID.serialized, 32)
            .storeUint(validUntil(), 32)
            .storeUint(seqno, 32)
            .storeSlice(actionsList.beginParse())
            .endCell();

        const signature = sign(payload.hash(), keypair.secretKey);
        const body = beginCell()
            .storeSlice(payload.beginParse())
            .storeUint(bufferToBigInt(signature), 512)
            .endCell();

        const receipt = await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: beginCell().storeSlice(body.beginParse()).endCell()
        });

        expect(receipt.transactions.length).toEqual(2);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        expect(receipt.transactions).not.toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;

        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should skip message if auth kind not given', async () => {
        const receipt = await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: beginCell().endCell()
        });

        expect(receipt.transactions.length).toEqual(2);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);
    });

    it('Should not revert on short "sint" messages', async () => {
        const receipt = await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: beginCell().storeUint(Opcodes.auth_signed_internal, 32).endCell()
        });

        expect(receipt.transactions.length).toEqual(2);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);
    });

    it('Should not revert on long incorrect "sint" messages', async () => {
        const receipt = await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: beginCell()
                .storeUint(Opcodes.auth_signed_internal, 32)
                .storeUint(0, 657)
                .endCell()
        });

        expect(receipt.transactions.length).toEqual(2);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);
    });

    it('Should skip message with simple text comment', async () => {
        const receipt = await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: beginCell().storeUint(0, 32).storeStringTail('Hello world').endCell()
        });

        expect(receipt.transactions.length).toEqual(2);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        console.debug(
            'SINGLE SIMPLE INTERNAL TRANSFER GAS USED:',
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).gasUsed
        );
    });

    it('Should skip message with longer text comment', async () => {
        const receipt = await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: beginCell().storeUint(0, 32).storeStringTail('Hello world'.repeat(20)).endCell()
        });

        expect(receipt.transactions.length).toEqual(2);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        console.debug(
            'SINGLE LONGER SIMPLE INTERNAL TRANSFER GAS USED:',
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).gasUsed
        );
    });

    it('Should fail disallowing signature auth with no exts', async () => {
        const actionsList = packActionsList([
            new ActionAddExtension(sender.address!)
        ]);

        await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: createBody(actionsList)
        });

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: packActionsList([
                new ActionRemoveExtension(sender.address!),
                new ActionSetSignatureAuthAllowed(false)
            ])
        });

        expect(receipt.transactions.length).toEqual(3); // sender_wallet -> wallet_v5 -> bounced

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(142);

        const isSignatureAuthAllowed = await walletV5.getIsSignatureAuthAllowed();
        expect(isSignatureAuthAllowed).toEqual(-1);
    });

    it('Should fail allowing signature auth when allowed', async () => {
        await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension(sender.address!)
            ]))
        });

        const actionsList = packActionsList([
            new ActionSetSignatureAuthAllowed(true)
        ]);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actionsList
        });

        expect(receipt.transactions.length).toEqual(3); // sender_wallet -> wallet_v5 -> bounced

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(143);

        const isSignatureAuthAllowed = await walletV5.getIsSignatureAuthAllowed();
        expect(isSignatureAuthAllowed).toEqual(-1);
    });

    it('Should add ext and disallow signature auth', async () => {
        await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension(sender.address!)
            ]))
        });

        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');

        const actionsList = packActionsList([
            new ActionAddExtension(testExtension),
            new ActionSetSignatureAuthAllowed(false)
        ]);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actionsList
        });

        expect(receipt.transactions.length).toEqual(2);

        accountForGas(receipt.transactions);

        const extensionsDict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );

        expect(extensionsDict.size).toEqual(2);

        expect(extensionsDict.get(packAddress(testExtension))).toEqual(
            -1n
        );

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        const isSignatureAuthAllowed = await walletV5.getIsSignatureAuthAllowed();
        expect(isSignatureAuthAllowed).toEqual(0);

        const contract_seqno = await walletV5.getSeqno();
        expect(contract_seqno).toEqual(seqno);
    });

    it('Should add ext and disallow signature auth in separate txs', async () => {
        await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension(sender.address!)
            ]))
        });

        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');

        const actionsList = packActionsList([
            new ActionAddExtension(testExtension)
        ]);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actionsList
        });

        expect(receipt.transactions.length).toEqual(2);

        accountForGas(receipt.transactions);

        const extensionsDict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );

        expect(extensionsDict.size).toEqual(2);

        expect(extensionsDict.get(packAddress(testExtension))).toEqual(
            -1n
        );

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        const isSignatureAuthAllowed = await walletV5.getIsSignatureAuthAllowed();
        expect(isSignatureAuthAllowed).toEqual(-1);

        const actionsList2 = packActionsList([
            new ActionSetSignatureAuthAllowed(false)
        ]);

        const receipt2 = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actionsList2
        });

        expect(receipt2.transactions.length).toEqual(2);

        accountForGas(receipt2.transactions);

        expect(
            (
                (receipt2.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        const isSignatureAuthAllowed2 = await walletV5.getIsSignatureAuthAllowed();
        expect(isSignatureAuthAllowed2).toEqual(0);

        const contract_seqno = await walletV5.getSeqno();
        expect(contract_seqno).toEqual(seqno);
    });

    it('Should add ext, disallow sign, allow sign, remove ext in one tx; send in other', async () => {
        await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension(sender.address!)
            ]))
        });

        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');

        const actionsList = packActionsList([
            new ActionAddExtension(testExtension),
            new ActionSetSignatureAuthAllowed(false),
            new ActionSetSignatureAuthAllowed(true),
            new ActionRemoveExtension(testExtension),
        ]);
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actionsList
        });

        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        const isSignatureAuthAllowed = await walletV5.getIsSignatureAuthAllowed();
        expect(isSignatureAuthAllowed).toEqual(-1);

        const contract_seqno = await walletV5.getSeqno();
        expect(contract_seqno).toEqual(seqno);

        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;

        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });

        const actionsList2 = packActionsList([
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)
        ]);

        const receipt2 = await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: createBody(actionsList2)
        });

        expect(receipt2.transactions.length).toEqual(3);
        accountForGas(receipt2.transactions);

        expect(receipt2.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const fee = receipt2.transactions[2].totalFees.coins;
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);
    });

    it('Should fail removing last extension with signature auth disabled', async () => {
        await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension(sender.address!)
            ]))
        });

        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');

        const actionsList = packActionsList([
            new ActionAddExtension(testExtension),
            new ActionSetSignatureAuthAllowed(false),
            new ActionRemoveExtension(testExtension),
            new ActionRemoveExtension(sender.address!)
        ]);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actionsList
        });

        expect(receipt.transactions.length).toEqual(3); // sender_wallet -> wallet_v5 -> bounced
        accountForGas(receipt.transactions);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(144);

        const isSignatureAuthAllowed = await walletV5.getIsSignatureAuthAllowed();
        expect(isSignatureAuthAllowed).toEqual(-1);
    });

    it('Should fail disallowing signature auth twice in tx', async () => {
        await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension(sender.address!)
            ]))
        });

        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');

        const actionsList = packActionsList([
            new ActionAddExtension(testExtension),
            new ActionSetSignatureAuthAllowed(false),
            new ActionSetSignatureAuthAllowed(false)
        ]);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actionsList
        });

        expect(receipt.transactions.length).toEqual(3); // sender_wallet -> wallet_v5 -> bounced
        accountForGas(receipt.transactions);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(143);

        const isSignatureAuthAllowed = await walletV5.getIsSignatureAuthAllowed();
        expect(isSignatureAuthAllowed).toEqual(-1); // throw when handling, packet is dropped
    });

    it('Should add ext, disallow sig auth; fail different signed tx', async () => {
        await walletV5.sendInternal(sender, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension(sender.address!)
            ]))
        });

        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');

        const actionsList = packActionsList([
            new ActionAddExtension(testExtension),
            new ActionSetSignatureAuthAllowed(false)
        ]);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actionsList
        });

        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);

        const extensionsDict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );

        expect(extensionsDict.size).toEqual(2);

        expect(extensionsDict.get(packAddress(testExtension))).toEqual(
            -1n
        );

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        const isSignatureAuthAllowed = await walletV5.getIsSignatureAuthAllowed();
        expect(isSignatureAuthAllowed).toEqual(0);

        const contract_seqno = await walletV5.getSeqno();
        expect(contract_seqno).toEqual(seqno);

        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });
        const actionsList2 = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        const receipt2 = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList2)
        });

        expect(
            (
                (receipt2.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(132);

        expect(receipt2.transactions).not.toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;

        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });
});
