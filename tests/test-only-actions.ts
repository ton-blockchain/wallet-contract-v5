import {
    Address,
    beginCell,
    Cell,
    CurrencyCollection,
    MessageRelaxed,
    SendMode,
    storeCurrencyCollection,
    storeMessageRelaxed
} from '@ton/core';
import {
    ExtendedAction,
    OutAction
} from './actions';

export type LibRef = Cell | bigint;

export class ActionSetCode {
    public static readonly tag = 0xad4de08e;

    public readonly tag = ActionSetCode.tag;

    constructor(public readonly newCode: Cell) {}

    public serialize(): Cell {
        return beginCell().storeUint(this.tag, 32).storeRef(this.newCode).endCell();
    }
}

export class ActionReserveCurrency {
    public static readonly tag = 0x36e6b809;

    public readonly tag = ActionReserveCurrency.tag;

    constructor(public readonly mode: SendMode, public readonly currency: CurrencyCollection) {}

    public serialize(): Cell {
        return beginCell()
            .storeUint(this.tag, 32)
            .storeUint(this.mode, 8)
            .store(storeCurrencyCollection(this.currency))
            .endCell();
    }
}

export class ActionChangeLibrary {
    public static readonly tag = 0x26fa1dd4;

    public readonly tag = ActionChangeLibrary.tag;

    constructor(public readonly mode: number, public readonly libRef: LibRef) {}

    public serialize(): Cell {
        const cell = beginCell().storeUint(this.tag, 32).storeUint(this.mode, 7);
        if (typeof this.libRef === 'bigint') {
            return cell.storeUint(0, 1).storeUint(this.libRef, 256).endCell();
        }

        return cell.storeUint(1, 1).storeRef(this.libRef).endCell();
    }
}

export class ActionSetData {
    public static readonly tag = 0x1ff8ea0b;

    public readonly tag = ActionSetData.tag;

    constructor(public readonly data: Cell) {}

    public serialize(): Cell {
        return beginCell().storeUint(this.tag, 32).storeRef(this.data).endCell();
    }
}

export type TestOnlyOutAction = ActionSetCode | ActionReserveCurrency | ActionChangeLibrary;
export type TestOnlyExtendedAction = ActionSetData;

export function isTestOnlyExtendedAction(action: OutAction | ExtendedAction): action is ExtendedAction {
    return (
        action.tag === ActionSetData.tag
    );
}
