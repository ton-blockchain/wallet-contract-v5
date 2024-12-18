import { Address, beginCell, Cell, CurrencyCollection, MessageRelaxed, StateInit } from '@ton/core';

export function bufferToBigInt(buffer: Buffer): bigint {
    return BigInt('0x' + buffer.toString('hex'));
}

export function packAddress(address: Address) {
    return bufferToBigInt(address.hash);
}

export function validUntil(ttlMs = 1000 * 60 * 3) {
    return Math.floor((Date.now() + ttlMs) / 1000);
}

export function createMsgInternal(params: {
    bounce?: boolean;
    dest: Address;
    value: bigint | CurrencyCollection;
    body?: Cell;
    init?: StateInit | null;
}): MessageRelaxed {
    return {
        info: {
            type: 'internal',
            ihrDisabled: true,
            bounce: params.bounce ?? false,
            bounced: false,
            dest: params.dest,
            value: typeof params.value === 'bigint' ? { coins: params.value } : params.value,
            ihrFee: 0n,
            forwardFee: 0n,
            createdLt: 0n,
            createdAt: 0
        },
        body: params.body || beginCell().endCell(),
        init: params.init
    };
}

export const randomAddress = (wc: number = 0) => {
    const buf = Buffer.alloc(32);
    for (let i = 0; i < buf.length; i++) {
        buf[i] = Math.floor(Math.random() * 256);
    }
    return new Address(wc, buf);
};

export const differentAddress = (old: Address) => {
    let newAddr: Address;
    do {
        newAddr = randomAddress(old.workChain);
    } while(newAddr.equals(old));

    return newAddr;
}

const getRandom = (min:number, max:number) => {
    return Math.random() * (max - min) + min;
}

export const getRandomInt = (min: number, max: number) => {
    return Math.round(getRandom(min, max));
}

export const pickRandomN = (min: number, max: number, count: number): number[] => {
    if(count > max - min) {
        throw new Error("Element count can't be larger than range");
    }

    let uniqSet: Set<number> = new Set();
    let foundCount = 0;
    // I know it' inefficient
    do {
        const atempt = getRandomInt(min, max)
        if(!uniqSet.has(atempt)) {
            foundCount++;
            uniqSet.add(atempt);
        }
    } while(foundCount < count);

    return [...uniqSet];
}

export const pickRandomNFrom = <T>(count: number, from: T[]): T[] => {
    let resultPick: T[] = new Array(count);
    const pickIdxs = pickRandomN(0, from.length - 1, count);

    for(let i = 0; i < pickIdxs.length; i++) {
        resultPick[i] = from[pickIdxs[i]];
    }

    return resultPick;
}
export const testArgs = (...args: unknown[]) => {
    for(let arg of args) {
        if(arg === undefined || arg === null) {
            throw TypeError("Required argument is missing!");
        }
    }
}


export async function disableConsoleError(callback: () => Promise<void>): Promise<void> {
    const errorsHandler = console.error;
    console.error = () => {};
    await callback();
    console.error = errorsHandler;
}
