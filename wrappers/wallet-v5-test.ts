import { Cell, beginCell, Sender, ContractProvider, SendMode, MessageRelaxed, Address, toNano, contractAddress, OutAction, OutActionSendMsg, Builder, storeOutList } from '@ton/core';
import { WalletV5, WalletV5Config, walletV5ConfigToCell, Opcodes } from './wallet-v5';
import { sign } from '@ton/crypto';

export type WalletActions = {
    wallet?: OutAction[] | Cell,
    extended?: ExtendedAction[] | Cell
}

export type ExtensionAdd = {
    type: 'add_extension',
    address: Address
}
export type ExtensionRemove = {
    type: 'remove_extension',
    address: Address
}

export type SetSignatureAuth = {
    type: 'sig_auth',
    allowed: boolean
}

export type ExtendedAction = ExtensionAdd | ExtensionRemove | SetSignatureAuth;

export type MessageOut = {
    message: MessageRelaxed,
    mode: SendMode
};

function storeWalletActions(actions: WalletActions) {
    // store compatable
    return (builder: Builder) => {
        let hasExtendedActions = false;
        if(actions.wallet) {
            let actionCell: Cell | null = null;
            if(actions.wallet instanceof Cell) {
                actionCell = actions.wallet;
            }
            else if(actions.wallet.length > 0) {
                actionCell = beginCell().store(storeOutList(actions.wallet)).endCell();
            }
            builder.storeMaybeRef(actionCell);
        }
        else {
            builder.storeBit(false);
        }
        if(actions.extended) {
            if(actions.extended instanceof Cell) {
                builder.storeBit(true);
                builder.storeSlice(actions.extended.asSlice());
            }
            else if(actions.extended.length > 0) {
                builder.storeBit(true);
                builder.store(storeExtendedActions(actions.extended));
            }
            else {
                builder.storeBit(false);
            }
        }
        else {
            builder.storeBit(false);
        }
    }
}

function storeExtensionAction(action: ExtendedAction) {
    return (builder: Builder) => {
        if(action.type == 'add_extension') {
            builder.storeUint(2, 8).storeAddress(action.address);
        }
        else if(action.type == 'remove_extension') {
            builder.storeUint(3, 8).storeAddress(action.address);
        }
        else {
            builder.storeUint(4, 8).storeBit(action.allowed);
        }
    }
}

export function storeExtendedActions(actions: ExtendedAction[]) {
    const cell = actions.reverse().reduce((curCell, action) => {
        const ds = beginCell().store(storeExtensionAction(action));
        if(curCell.bits.length > 0) {
            ds.storeRef(curCell);
        }
        return ds.endCell();
    }, beginCell().endCell());

    return (builder: Builder) => builder.storeSlice(cell.beginParse());
}

export function message2action(msg: MessageOut) : OutActionSendMsg {
    return {
        type: 'sendMsg',
        mode: msg.mode,
        outMsg: msg.message
    }
}


export class WalletV5Test extends WalletV5 {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {
        super(address, init);
    }
    static createFromAddress(address: Address) {
        return new WalletV5Test(address);
    }

    static createFromConfig(config: WalletV5Config, code: Cell, workchain = 0) {
        const data = walletV5ConfigToCell(config);
        const init = { code, data };
        return new WalletV5Test(contractAddress(workchain, init), init);
    }
    static requestMessage(internal: boolean, wallet_id: bigint, valid_until: number, seqno: bigint | number, actions: WalletActions, key?: Buffer) {
        const op = internal ? Opcodes.auth_signed_internal : Opcodes.auth_signed;
        const msgBody = beginCell().storeUint(op, 32)
                          .storeUint(wallet_id, 32)
                          .storeUint(valid_until, 32)
                          .storeUint(seqno, 32)
                          .store(storeWalletActions(actions))
                        .endCell();
        return key ? WalletV5Test.signRequestMessage(msgBody, key) : msgBody;
    }

    static signRequestMessage(msg: Cell, key: Buffer) {
        const signature = sign(msg.hash(), key);

        return beginCell().storeSlice(msg.asSlice()).storeBuffer(signature).endCell();
    }
    async sendMessagesExternal(provider: ContractProvider,
                               wallet_id: bigint,
                               valid_until: number,
                               seqno: bigint | number,
                               key: Buffer, messages: MessageOut[]) {
        const actions: OutActionSendMsg[] = messages.map(message2action);

        await provider.external(
            WalletV5Test.requestMessage(false, wallet_id, valid_until, seqno, {wallet: actions}, key)
        );
    }

    static extensionMessage(actions: WalletActions, query_id: bigint | number = 0) {
        return beginCell()
                .storeUint(Opcodes.auth_extension, 32)
                .storeUint(query_id, 64)
                .store(storeWalletActions(actions))
               .endCell();
    }
    async sendExtensionActions(provider: ContractProvider,
                               via: Sender,
                               actions: WalletActions,
                               value: bigint = toNano('0.1'),
                               query_id: bigint | number = 0) {

        await provider.internal(via, {
            value,
            body: WalletV5Test.extensionMessage(actions, query_id),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }

    async sendMessagesInternal(provider: ContractProvider, via: Sender,
                               wallet_id: bigint,
                               valid_until: number,
                               seqno: bigint | number,
                               key: Buffer, messages: MessageOut[], value: bigint = toNano('0.05')) {
        
        const actions: OutActionSendMsg[] = messages.map(message2action);
        
        await provider.internal(via, {
            value,
            body: WalletV5Test.requestMessage(true, wallet_id, valid_until, seqno, {wallet: actions}, key),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }

    /*
    async sendAddExtensionViaExternal(provider: ContractProvider,
                                       wallet_id: bigint,
                                       valid_until: number,
                                       seqno: bigint | number,
                                       key: Buffer, 
                                       extensions: Address[]) {
        const reqMsg = WalletV5Test.requestMessage(false, wallet_id, valid_until, seqno, {extension: beginCell().endCell()}, key);

        await provider.external(reqMsg);
    }
    */
}
