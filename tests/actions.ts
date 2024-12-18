import { Address, beginCell, Cell, MessageRelaxed, SendMode, storeMessageRelaxed } from '@ton/core';
import { isTestOnlyExtendedAction, TestOnlyExtendedAction, TestOnlyOutAction } from './test-only-actions';

export class ActionSendMsg {
    public static readonly tag = 0x0ec3c86d;

    public readonly tag = ActionSendMsg.tag;

    constructor(public readonly mode: SendMode, public readonly outMsg: MessageRelaxed) {}

    public serialize(): Cell {
        return beginCell()
            .storeUint(this.tag, 32)
            .storeUint(this.mode | SendMode.IGNORE_ERRORS, 8)
            .storeRef(beginCell().store(storeMessageRelaxed(this.outMsg)).endCell())
            .endCell();
    }
}

export class ActionAddExtension {
    public static readonly tag = 0x02;

    public readonly tag = ActionAddExtension.tag;

    constructor(public readonly address: Address) {}

    public serialize(): Cell {
        return beginCell().storeUint(this.tag, 8).storeAddress(this.address).endCell();
    }
}

export class ActionRemoveExtension {
    public static readonly tag = 0x03;

    public readonly tag = ActionRemoveExtension.tag;

    constructor(public readonly address: Address) {}

    public serialize(): Cell {
        return beginCell().storeUint(this.tag, 8).storeAddress(this.address).endCell();
    }
}

export class ActionSetSignatureAuthAllowed {
    public static readonly tag = 0x04;

    public readonly tag = ActionSetSignatureAuthAllowed.tag;

    constructor(public readonly allowed: Boolean) {}

    public serialize(): Cell {
        return beginCell()
            .storeUint(this.tag, 8)
            .storeUint(this.allowed ? 1 : 0, 1)
            .endCell();
    }
}

export type OutAction = ActionSendMsg | TestOnlyOutAction;
export type ExtendedAction =
    | ActionAddExtension
    | ActionRemoveExtension
    | ActionSetSignatureAuthAllowed
    | TestOnlyExtendedAction;

export function isExtendedAction(action: OutAction | ExtendedAction): action is ExtendedAction {
    return (
        action.tag === ActionAddExtension.tag ||
        action.tag === ActionRemoveExtension.tag ||
        action.tag === ActionSetSignatureAuthAllowed.tag ||
        isTestOnlyExtendedAction(action)
    );
}

function packActionsListOut(actions: (OutAction | ExtendedAction)[]): Cell {
    if (actions.length === 0) {
        return beginCell().endCell();
    }

    const [action, ...rest] = actions;

    if (isExtendedAction(action)) {
        throw new Error('Actions bust be in an order: all extended actions, all out actions');
    }

    return beginCell()
        .storeRef(packActionsListOut(rest))
        .storeSlice(action.serialize().beginParse())
        .endCell();
}

function packExtendedActions(extendedActions: ExtendedAction[]): Cell {
    const first = extendedActions[0];
    const rest = extendedActions.slice(1);
    let builder = beginCell()
        .storeSlice(first.serialize().beginParse());
    if (rest.length > 0) {
        builder = builder.storeRef(packExtendedActions(extendedActions.slice(1)));
    }
    return builder.endCell();
}

function packActionsListExtended(actions: (OutAction | ExtendedAction)[]): Cell {
    const extendedActions: ExtendedAction[] = [];
    const outActions: OutAction[] = [];
    actions.forEach(action => {
        if (isExtendedAction(action)) {
            extendedActions.push(action);
        } else {
            outActions.push(action);
        }
    });

    let builder = beginCell();
    if (outActions.length === 0) {
        builder = builder.storeUint(0, 1);
    } else {
        builder = builder.storeMaybeRef(packActionsListOut(outActions.slice().reverse()));
    }
    if (extendedActions.length === 0) {
        builder = builder.storeUint(0, 1);
    } else {
        const first = extendedActions[0];
        const rest = extendedActions.slice(1);
        builder = builder
            .storeUint(1, 1)
            .storeSlice(first.serialize().beginParse());
        if (rest.length > 0) {
            builder = builder.storeRef(packExtendedActions(rest));
        }
    }
    return builder.endCell();
}

export function packActionsList(actions: (OutAction | ExtendedAction)[]): Cell {
    return packActionsListExtended(actions);
}
