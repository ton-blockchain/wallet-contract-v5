import { Blockchain, SandboxContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, Sender, toNano } from '@ton/core';
import { WalletId, WalletV5 } from '../wrappers/wallet-v5';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed } from 'ton-crypto';
import { bufferToBigInt, packAddress } from './utils';
import { buildBlockchainLibraries, LibraryDeployer } from '../wrappers/library-deployer';

const WALLET_ID = new WalletId({ networkGlobalId: -239, workChain: 0, subwalletNumber: 0 });

describe('Wallet V5 get methods', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('wallet_v5');
    });

    let blockchain: Blockchain;
    let walletV5: SandboxContract<WalletV5>;
    let keypair: KeyPair;
    let sender: Sender;

    async function deploy(params?: Partial<Parameters<typeof WalletV5.createFromConfig>[0]>) {
        blockchain = await Blockchain.create();
        blockchain.libs = buildBlockchainLibraries([code]);
        if (!params?.publicKey) {
            keypair = keyPairFromSeed(await getSecureRandomBytes(32));
        }

        walletV5 = blockchain.openContract(
            WalletV5.createFromConfig(
                {
                    signatureAllowed: true,
                    seqno: params?.seqno ?? 0,
                    walletId: params?.walletId ?? WALLET_ID.serialized,
                    publicKey: params?.publicKey ?? keypair.publicKey,
                    extensions: params?.extensions ?? Dictionary.empty()
                },
                LibraryDeployer.exportLibCode(code)
            )
        );

        const deployer = await blockchain.treasury('deployer');
        sender = deployer.getSender();

        const deployResult = await walletV5.sendDeploy(sender, toNano('0.05'));
        return { deployer, deployResult };
    }

    beforeEach(async () => {
        const { deployer, deployResult } = await deploy();

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: walletV5.address,
            deploy: true,
            success: true
        });
    });

    it('Get seqno', async () => {
        const expectedSeqno = 12345;
        await deploy({ seqno: expectedSeqno });
        const actualSeqno = await walletV5.getSeqno();
        expect(expectedSeqno).toEqual(actualSeqno);
    });

    it('Get pubkey', async () => {
        const actualPubkey = await walletV5.getPublicKey();
        expect(actualPubkey).toEqual(bufferToBigInt(keypair.publicKey));
    });

    it('Get wallet id', async () => {
        const expectedWalletId = new WalletId({
            networkGlobalId: -239,
            workChain: 0,
            subwalletNumber: 1
        });
        await deploy({ walletId: expectedWalletId.serialized });
        const actualWalletId = await walletV5.getWalletId();
        expect(expectedWalletId.subwalletNumber).toEqual(actualWalletId.subwalletNumber);
    });

    it('Get subwallet number', async () => {
        const subwalletNumber = 12345;
        const walletId = new WalletId({
            networkGlobalId: -239,
            workChain: 0,
            subwalletNumber
        });
        await deploy({ walletId: walletId.serialized });
        const actualSubwalletNumber = (await walletV5.getWalletId()).subwalletNumber;
        expect(subwalletNumber).toEqual(actualSubwalletNumber);
    });

    it('Default wallet id', async () => {
        const walletId = new WalletId({
            networkGlobalId: -239,
            workChain: 0,
            subwalletNumber: 0,
            walletVersion: 'v5'
        });
        const defaultWalletId = new WalletId();

        expect(walletId.serialized).toBe(defaultWalletId.serialized);
    });

    it('Get extensions dict', async () => {
        const plugin1 = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const plugin2 = Address.parse('EQA2pT4d8T7TyRsjW2BpGpGYga-lMA4JjQb4D2tc1PXMX5Bf');

        const extensions: Dictionary<bigint, bigint> = Dictionary.empty(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1)
        );
        extensions.set(packAddress(plugin1), -1n);
        extensions.set(packAddress(plugin2), -1n);

        await deploy({ extensions });

        const actual = await walletV5.getExtensions();
        const expected = beginCell()
            .storeDictDirect(extensions, Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1))
            .endCell();
        expect(actual?.equals(expected)).toBeTruthy();
    });

    it('Get extensions array', async () => {
        const plugin1 = Address.parse(
            '0:0000F5851B4A185F5F63C0D0CD0412F5ACA353F577DA18FF47C936F99DBD0000'
        );
        const plugin2 = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const plugin3 = Address.parse('EQA2pT4d8T7TyRsjW2BpGpGYga-lMA4JjQb4D2tc1PXMX5Bf');

        const extensions: Dictionary<bigint, bigint> = Dictionary.empty(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1)
        );
        extensions.set(packAddress(plugin1), -1n);
        extensions.set(packAddress(plugin2), -1n);
        extensions.set(packAddress(plugin3), -1n);

        await deploy({ extensions });

        const actual = await walletV5.getExtensionsArray();
        expect(actual.length).toBe(3);
        expect(actual[0].equals(plugin1)).toBeTruthy();
        expect(actual[1].equals(plugin2)).toBeTruthy();
        expect(actual[2].equals(plugin3)).toBeTruthy();
    });

    it('Get empty extensions array', async () => {
        const actual = await walletV5.getExtensionsArray();
        expect(actual.length).toBe(0);
    });
});
