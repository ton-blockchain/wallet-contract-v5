import {
    Address,
    beginCell,
    BitBuilder,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    DictionaryValue,
    Sender,
    SendMode,
    SimpleLibrary
} from '@ton/core';
import { SimpleLibraryValue } from '@ton/core/dist/types/SimpleLibrary';

export type LibraryDeployerConfig = {
    libraryCode: Cell;
};

export function buildBlockchainLibraries(libs: Cell[]): Cell {
    const libraries = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    libs.forEach(lib => libraries.set(BigInt('0x' + lib.hash().toString('hex')), lib));

    return beginCell().storeDictDirect(libraries).endCell();
}

export function buildLibraryStateInit(library: SimpleLibrary): Cell {
    const libraries = Dictionary.empty(
        Dictionary.Keys.BigUint(256),
        SimpleLibraryValue as unknown as DictionaryValue<SimpleLibrary>
    );
    libraries.set(BigInt('0x' + library.root.hash().toString('hex')), library);

    return beginCell().storeDictDirect(libraries).endCell();
}

export class LibraryDeployer implements Contract {
    static exportLibCode(code: Cell) {
        const bits = new BitBuilder();
        bits.writeUint(2, 8);
        bits.writeUint(BigInt('0x' + code.hash().toString('hex')), 256);

        return new Cell({ exotic: true, bits: bits.build() });
    }

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromConfig(config: LibraryDeployerConfig, code: Cell, workchain = -1) {
        const data = config.libraryCode;
        const init = { code, data };
        return new LibraryDeployer(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell()
        });
    }
}
