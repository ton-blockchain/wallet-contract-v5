import { compile } from '@ton-community/blueprint';
import { LibraryDeployer } from '../wrappers/library-deployer';

export async function run() {
    const walletCode = await compile('wallet_v5');
    const code = LibraryDeployer.exportLibCode(walletCode);

    console.log('WALLET CODE HEX', code.toBoc().toString('hex'), '\n');
    console.log('WALLET CODE BASE64', code.toBoc().toString('base64'), '\n');
    console.log('WALLET FULL CODE BASE64', walletCode.toBoc().toString('base64'));
}

run();
