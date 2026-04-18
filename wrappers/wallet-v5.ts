import {
    Address,
    beginCell,
    BitBuilder,
    BitReader,
    BitString,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    MessageRelaxed,
    storeOutList,
    OutAction,
    Sender,
    SendMode,
    Builder,
    OutActionSendMsg,
    toNano
} from '@ton/core';
import { bufferToBigInt } from '../tests/utils';

import { sign } from '@ton/crypto';

export type WalletV5Config = {
    signatureAllowed: boolean;
    seqno: number;
    walletId: bigint;
    publicKey: Buffer;
    extensions: Dictionary<bigint, bigint>;
};

export function walletV5ConfigToCell(config: WalletV5Config): Cell {
    return beginCell()
        .storeBit(config.signatureAllowed)
        .storeUint(config.seqno, 32)
        .storeUint(config.walletId, 32)
        .storeBuffer(config.publicKey, 32)
        .storeDict(config.extensions, Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1))
        .endCell();
}

export const Opcodes = {
    action_send_msg: 0x0ec3c86d,
    action_set_code: 0xad4de08e,
    action_extended_set_data: 0x1ff8ea0b,
    action_extended_add_extension: 0x02,
    action_extended_remove_extension: 0x03,
    action_extended_set_signature_auth_allowed: 0x04,
    auth_extension: 0x6578746e,
    auth_signed: 0x7369676e,
    auth_signed_internal: 0x73696e74
};

export class WalletId {
    static readonly versionsSerialisation: Record<WalletId['walletVersion'], number> = {
        v5: 0
    };

    static deserialize(walletId: bigint): WalletId {
        // const bitReader = new BitReader(
        //     new BitString(
        //         typeof walletId === 'bigint' ? Buffer.from(walletId.toString(16), 'hex') : walletId,
        //         0,
        //         32
        //     )
        // );
        // const networkGlobalId = bitReader.loadInt(32);
        // const workChain = bitReader.loadInt(8);
        // const walletVersionRaw = bitReader.loadUint(8);
        const subwalletNumber = walletId;
        //
        // const walletVersion = Object.entries(this.versionsSerialisation).find(
        //     ([_, value]) => value === walletVersionRaw
        // )?.[0] as WalletId['walletVersion'] | undefined;
        //
        // if (walletVersion === undefined) {
        //     throw new Error(
        //         `Can't deserialize walletId: unknown wallet version ${walletVersionRaw}`
        //     );
        // }
        //
        return new WalletId({ networkGlobalId: 0, workChain: 0, walletVersion: 'v5', subwalletNumber: Number(walletId) });
    }

    readonly walletVersion: 'v5';

    // -239 is mainnet, -3 is testnet
    readonly networkGlobalId: number;

    readonly workChain: number;

    readonly subwalletNumber: number;

    readonly serialized: bigint;

    constructor(args?: {
        networkGlobalId?: number;
        workChain?: number;
        subwalletNumber?: number;
        walletVersion?: 'v5';
    }) {
        this.networkGlobalId = args?.networkGlobalId ?? -239;
        this.workChain = args?.workChain ?? 0;
        this.subwalletNumber = args?.subwalletNumber ?? 0;
        this.walletVersion = args?.walletVersion ?? 'v5';

        // const bitBuilder = new BitBuilder(32);
        // bitBuilder.writeInt(this.networkGlobalId, 32);
        // bitBuilder.writeInt(this.workChain, 8);
        // bitBuilder.writeUint(WalletId.versionsSerialisation[this.walletVersion], 8);
        // bitBuilder.writeUint(this.subwalletNumber, 32);

        this.serialized = BigInt(this.subwalletNumber) // bufferToBigInt(bitBuilder.buffer());
    }
}

export class WalletV5 implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new WalletV5(address);
    }

    static createFromConfig(config: WalletV5Config, code: Cell, workchain = 0) {
        const data = walletV5ConfigToCell(config);
        const init = { code, data };
        return new WalletV5(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell()
        });
    }

    async sendInternalSignedMessage(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            body: Cell;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                // .storeUint(Opcodes.auth_signed_internal, 32) // Is signed inside message
                .storeSlice(opts.body.beginParse())
                .endCell()
        });
    }

    async sendInternalMessageFromExtension(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            body: Cell;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.auth_extension, 32)
                .storeUint(0, 64) // query id
                .storeSlice(opts.body.beginParse())
                .endCell()
        });
    }

    async sendInternal(
        provider: ContractProvider,
        via: Sender,
        opts: Parameters<ContractProvider['internal']>[1]
    ) {
        await provider.internal(via, opts);
    }

    async sendExternalSignedMessage(provider: ContractProvider, body: Cell) {
        await provider.external(body);
    }

    async sendExternal(provider: ContractProvider, body: Cell) {
        await provider.external(body);
    }

    async getPublicKey(provider: ContractProvider) {
        const result = await provider.get('get_public_key', []);
        return result.stack.readBigNumber();
    }

    async getSeqno(provider: ContractProvider) {
        const state = await provider.getState();
        if (state.state.type === 'active') {
            let res = await provider.get('seqno', []);
            return res.stack.readNumber();
        } else {
            return 0;
        }
    }

    async getIsSignatureAuthAllowed(provider: ContractProvider) {
        const state = await provider.getState();
        if (state.state.type === 'active') {
            let res = await provider.get('is_signature_allowed', []);
            return res.stack.readNumber();
        } else {
            return -1;
        }
    }

    async getWalletId(provider: ContractProvider) {
        const result = await provider.get('get_subwallet_id', []);
        return WalletId.deserialize(result.stack.readBigNumber());
    }

    async getExtensions(provider: ContractProvider) {
        const result = await provider.get('get_extensions', []);
        return result.stack.readCellOpt();
    }

    async getExtensionsArray(provider: ContractProvider) {
        const extensions = await this.getExtensions(provider);
        if (!extensions) {
            return [];
        }

        const dict: Dictionary<bigint, bigint> = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            extensions
        );

        return dict.keys().map(key => {
            const wc = this.address.workChain;
            const addressHex = key;
            return Address.parseRaw(`${wc}:${addressHex.toString(16).padStart(64, '0')}`);
        });
    }
}
