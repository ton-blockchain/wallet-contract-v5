import { Cell, Slice, toNano, beginCell, Address, Dictionary, Message, DictionaryValue, Transaction, BitString, SendMode, MessageRelaxed, CommonMessageInfoInternal, storeMessage, storeMessageRelaxed } from '@ton/core';
import { internal } from '@ton/sandbox';
import { randomAddress } from './utils';

export type GasPrices = {
	flat_gas_limit: bigint,
	flat_gas_price: bigint,
	gas_price: bigint;
};
export type StorageValue = {
    utime_sice: number,
    bit_price_ps: bigint,
    cell_price_ps: bigint,
    mc_bit_price_ps: bigint,
    mc_cell_price_ps: bigint
};


export type MsgPrices = ReturnType<typeof configParseMsgPrices>;
export type FullFees  = ReturnType<typeof computeFwdFeesVerbose>;

export class StorageStats {
    bits: bigint;
    cells: bigint;

    constructor(bits?: number | bigint, cells?: number | bigint) {
        this.bits  = bits  !== undefined ? BigInt(bits)  : 0n;
        this.cells = cells !== undefined ? BigInt(cells) : 0n;
    }
    add(...stats: StorageStats[]) {
        let cells = this.cells, bits = this.bits;
        for (let stat of stats) {
            bits  += stat.bits;
            cells += stat.cells;
        }
        return new StorageStats(bits, cells);
    }
    sub(...stats: StorageStats[]) {
        let cells = this.cells, bits = this.bits;
        for (let stat of stats) {
            bits  -= stat.bits;
            cells -= stat.cells;
        }
        return new StorageStats(bits, cells);
    }
    addBits(bits: number | bigint) {
        return new StorageStats(this.bits + BigInt(bits), this.cells);
    }
    subBits(bits: number | bigint) {
        return new StorageStats(this.bits - BigInt(bits), this.cells);
    }
    addCells(cells: number | bigint) {
        return new StorageStats(this.bits, this.cells + BigInt(cells));
    }
    subCells(cells: number | bigint) {
        return new StorageStats(this.bits, this.cells - BigInt(cells));
    }

    toString() : string {
        return JSON.stringify({
            bits: this.bits.toString(),
            cells: this.cells.toString()
        });
    }
}

export function computedGeneric<T extends Transaction>(transaction: T) {
    if(transaction.description.type !== "generic")
        throw("Expected generic transactionaction");
    if(transaction.description.computePhase.type !== "vm")
        throw("Compute phase expected")
    return transaction.description.computePhase;
}

export function storageGeneric<T extends Transaction>(transaction: T) {
    if(transaction.description.type !== "generic")
        throw("Expected generic transactionaction");
    const storagePhase = transaction.description.storagePhase;
    if(storagePhase  === null || storagePhase === undefined)
        throw("Storage phase expected")
    return storagePhase;
}

function shr16ceil(src: bigint) {
    let rem = src % BigInt(65536);
    let res = src / 65536n; // >> BigInt(16);
    if (rem != BigInt(0)) {
        res += BigInt(1);
    }
    return res;
}

export function collectCellStats(cell: Cell, visited:Array<string>, skipRoot: boolean = false): StorageStats {
    let bits  = skipRoot ? 0n : BigInt(cell.bits.length);
    let cells = skipRoot ? 0n : 1n;
    let hash = cell.hash().toString();
    if (visited.includes(hash)) {
        // We should not account for current cell data if visited
        return new StorageStats();
    }
    else {
        visited.push(hash);
    }
    for (let ref of cell.refs) {
        let r = collectCellStats(ref, visited);
        cells += r.cells;
        bits += r.bits;
    }
    return new StorageStats(bits, cells);
}

export function getGasPrices(configRaw: Cell, workchain: 0 | -1): GasPrices {
  const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());

	const ds = config.get(21 + workchain)!.beginParse();
	if(ds.loadUint(8) !== 0xd1) {
			throw new Error("Invalid flat gas prices tag!");
	}

	const flat_gas_limit = ds.loadUintBig(64);
	const flat_gas_price = ds.loadUintBig(64);

	if(ds.loadUint(8) !== 0xde) {
			throw new Error("Invalid gas prices tag!");
	}
	return {
		flat_gas_limit,
		flat_gas_price,
		gas_price: ds.preloadUintBig(64)
	};
}

export function setGasPrice(configRaw: Cell, prices: GasPrices, workchain: 0 | -1) : Cell {
  const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());
  const idx    = 21 + workchain;
	const ds = config.get(idx)!;
	const tail = ds.beginParse().skip(8 + 64 + 64 + 8 + 64);

	const newPrices = beginCell().storeUint(0xd1, 8)
										.storeUint(prices.flat_gas_limit, 64)
										.storeUint(prices.flat_gas_price, 64)
										.storeUint(0xde, 8)
										.storeUint(prices.gas_price, 64)
										.storeSlice(tail)
			      			.endCell();
    config.set(idx, newPrices);

    return beginCell().storeDictDirect(config).endCell();
}

export const storageValue : DictionaryValue<StorageValue> =  {
        serialize: (src, builder) => {
            builder.storeUint(0xcc, 8)
                   .storeUint(src.utime_sice, 32)
                   .storeUint(src.bit_price_ps, 64)
                   .storeUint(src.cell_price_ps, 64)
                   .storeUint(src.mc_bit_price_ps, 64)
                   .storeUint(src.mc_cell_price_ps, 64)
        },
        parse: (src) => {
            return {
                utime_sice: src.skip(8).loadUint(32),
                bit_price_ps: src.loadUintBig(64),
                cell_price_ps: src.loadUintBig(64),
                mc_bit_price_ps: src.loadUintBig(64),
                mc_cell_price_ps: src.loadUintBig(64)
            };
        }
    };

export function getStoragePrices(configRaw: Cell) {
    const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());
    const storageData = Dictionary.loadDirect(Dictionary.Keys.Uint(32),storageValue, config.get(18)!);
    const values      = storageData.values();

    return values[values.length - 1];
}
export function calcStorageFee(prices: StorageValue, stats: StorageStats, duration: bigint) {
    return shr16ceil((stats.bits * prices.bit_price_ps + stats.cells * prices.cell_price_ps) * duration) 
}
export function setStoragePrices(configRaw: Cell, prices: StorageValue) {
    const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());
    const storageData = Dictionary.loadDirect(Dictionary.Keys.Uint(32),storageValue, config.get(18)!);
    storageData.set(storageData.values().length - 1, prices);
    config.set(18, beginCell().storeDictDirect(storageData).endCell());
    return beginCell().storeDictDirect(config).endCell();
}

export function computeGasFee(prices: GasPrices, gas: bigint): bigint {
    if(gas <= prices.flat_gas_limit) {
        return prices.flat_gas_price;
    }
    return prices.flat_gas_price + prices.gas_price * (gas - prices.flat_gas_limit) / 65536n
}

export function computeDefaultForwardFee(msgPrices: MsgPrices) {
    return msgPrices.lumpPrice - ((msgPrices.lumpPrice * msgPrices.firstFrac) >> BigInt(16));
}

export function computeCellForwardFees(msgPrices: MsgPrices, msg: Cell) {
    let storageStats = collectCellStats(msg, [], true);
    return computeFwdFees(msgPrices, storageStats.cells, storageStats.bits);
}
export function computeMessageForwardFees(msgPrices: MsgPrices, msg: Message)  {
    // let msg = loadMessageRelaxed(cell.beginParse());
    let storageStats = new StorageStats();

    if( msg.info.type !== "internal") {
        throw Error("Helper intended for internal messages");
    }
    const defaultFwd = computeDefaultForwardFee(msgPrices);
    // If message forward fee matches default than msg cell is flat
    if(msg.info.forwardFee == defaultFwd) {
        return {fees: {total: msgPrices.lumpPrice, res : defaultFwd, remaining: defaultFwd}, stats: storageStats};
    }
    let visited : Array<string> = [];
    // Init
    if (msg.init) {
        let addBits  = 5n; // Minimal additional bits
        let refCount = 0;
        if(msg.init.splitDepth) {
            addBits += 5n;
        }
        if(msg.init.libraries) {
            refCount++;
            storageStats = storageStats.add(collectCellStats(beginCell().storeDictDirect(msg.init.libraries).endCell(), visited, true));
        }
        if(msg.init.code) {
            refCount++;
            storageStats = storageStats.add(collectCellStats(msg.init.code, visited))
        }
        if(msg.init.data) {
            refCount++;
            storageStats = storageStats.add(collectCellStats(msg.init.data, visited));
        }
        if(refCount >= 2) { //https://github.com/ton-blockchain/ton/blob/51baec48a02e5ba0106b0565410d2c2fd4665157/crypto/block/transaction.cpp#L2079
            storageStats.cells++;
            storageStats.bits += addBits;
        }
    }
    const lumpBits  = BigInt(msg.body.bits.length);
    const bodyStats = collectCellStats(msg.body,visited, true);
    storageStats = storageStats.add(bodyStats);

    // NOTE: Extra currencies are ignored for now
    let fees = computeFwdFeesVerbose(msgPrices, BigInt(storageStats.cells), BigInt(storageStats.bits));
    // Meeh
    if(fees.remaining < msg.info.forwardFee) {
        // console.log(`Remaining ${fees.remaining} < ${msg.info.forwardFee} lump bits:${lumpBits}`);
        storageStats = storageStats.addCells(1).addBits(lumpBits);
        fees = computeFwdFeesVerbose(msgPrices, storageStats.cells, storageStats.bits);
    }
    if(fees.remaining != msg.info.forwardFee) {
        console.log("Result fees:", fees);
        console.log(msg);
        console.log(fees.remaining);
        throw(new Error("Something went wrong in fee calcuation!"));
    }
    return {fees, stats: storageStats};
}

export const configParseMsgPrices = (sc: Slice) => {

    let magic = sc.loadUint(8);

    if(magic != 0xea) {
        throw Error("Invalid message prices magic number!");
    }
    return {
        lumpPrice:sc.loadUintBig(64),
        bitPrice: sc.loadUintBig(64),
        cellPrice: sc.loadUintBig(64),
        ihrPriceFactor: sc.loadUintBig(32),
        firstFrac: sc.loadUintBig(16),
        nextFrac:  sc.loadUintBig(16)
    };
}

export const setMsgPrices = (configRaw: Cell, prices: MsgPrices, workchain: 0 | -1) => {
    const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());

    const priceCell = beginCell().storeUint(0xea, 8)
                      .storeUint(prices.lumpPrice, 64)
                      .storeUint(prices.bitPrice, 64)
                      .storeUint(prices.cellPrice, 64)
                      .storeUint(prices.ihrPriceFactor, 32)
                      .storeUint(prices.firstFrac, 16)
                      .storeUint(prices.nextFrac, 16)
                     .endCell();
    config.set(25 + workchain, priceCell);

    return beginCell().storeDictDirect(config).endCell();
}

export const getMsgPrices = (configRaw: Cell, workchain: 0 | -1 ) => {

    const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());

    const prices = config.get(25 + workchain);

    if(prices === undefined) {
        throw Error("No prices defined in config");
    }

    return configParseMsgPrices(prices.beginParse());
}

export function computeFwdFees(msgPrices: MsgPrices, cells: bigint, bits: bigint) {
    return msgPrices.lumpPrice + (shr16ceil((msgPrices.bitPrice * bits)
         + (msgPrices.cellPrice * cells))
    );
}

export function computeFwdFeesVerbose(msgPrices: MsgPrices, cells: bigint | number, bits: bigint | number) {
    const fees = computeFwdFees(msgPrices, BigInt(cells), BigInt(bits));

    const res = (fees * msgPrices.firstFrac) >> 16n;
    return {
        total: fees,
        res,
        remaining: fees - res
    }
}

export const setPrecompiledGas = (configRaw: Cell, code_hash: Buffer, gas_usage: number) => {
    const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());

    const entry = beginCell().storeUint(0xb0, 8)
      .storeUint(gas_usage, 64)
      .endCell().beginParse();
    let dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.BitString(8 + 64));
    dict.set(code_hash, entry.loadBits(8 + 64));
    const param = beginCell().storeUint(0xc0, 8).storeBit(1).storeRef(beginCell().storeDictDirect(dict).endCell()).endCell();

    config.set(45, param);

    return beginCell().storeDictDirect(config).endCell();
};

export const estimateMessageImpact = <T extends Transaction>(message: MessageRelaxed, sendTx: T, msgPrices: MsgPrices, balanceBefore: bigint, mode: SendMode, computed: boolean) => {

    if(message.info.type !== 'internal') {
        throw new TypeError("External message is not supported!");
    }

    const computePhase = computedGeneric(sendTx);

    let inValue   = 0n;
    let inMessage = sendTx.inMessage;
    let feesPaid  = false;

    if(inMessage) {
        if(inMessage.info.type == 'internal') {
            inValue = inMessage.info.value.coins;
        }
        else if(inMessage.info.type == 'external-in') {
            // Negative because of import cost
            inValue -= computeCellForwardFees(msgPrices, beginCell().store(storeMessage(inMessage)).endCell());
        }
        else {
            throw new TypeError("external-out can't be incomming message!");
        }
    }

    const msgPacked = beginCell().store(storeMessageRelaxed(message)).endCell();

    const fees = computeCellForwardFees(msgPrices, msgPacked);

    let expOut  = message.info.value.coins;

    let balanceAfter = balanceBefore - expOut;
    // Usually means it's not the first action, so gas has already been deducted and credit added
    if(!computed) {
        balanceAfter += inValue - computePhase.gasFees;
    }

    if(!(mode  & SendMode.PAY_GAS_SEPARATELY)) {
        expOut -= fees;
        feesPaid = true;
    }
    else {
        balanceAfter -= fees;
    }
    /*
    else if(mode & SendMode.PAY_GAS_SEPARATELY) {
        if(!(mode & SendMode.CARRY_ALL_REMAINING_BALANCE) || (mode & SendMode.CARRY_ALL_REMAINING_INCOMING_VALUE)) {
            balanceAfter -= fees;
        }
    }
    */
    if(mode & SendMode.CARRY_ALL_REMAINING_BALANCE) {
        expOut = balanceAfter - fees + message.info.value.coins;
        balanceAfter = 0n;
    }
    if(mode & SendMode.CARRY_ALL_REMAINING_INCOMING_VALUE) {
        if(mode & SendMode.CARRY_ALL_REMAINING_BALANCE) {
            throw new TypeError("Mode 64 and 128 is not compatible");
        }
        if(!inMessage) {
            throw new Error("Mode 64 doesn't work without incomming message");
        }
        if(inMessage.info.type != 'internal') {
            throw new Error("Mode 64 doesn't work with external incomming message");
        }

        expOut = inValue - computePhase.gasFees + message.info.value.coins - fees;
        balanceAfter -= inValue - computePhase.gasFees;
        /*
        if(!feesPaid) {
            expOut -= fees;
        }
        */
    }
    return {expValue: expOut, balanceAfter};
}
