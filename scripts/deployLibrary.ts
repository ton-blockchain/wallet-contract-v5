import { toNano } from 'ton-core';
import { compile, NetworkProvider } from '@ton/blueprint';
import 'dotenv/config';
import { LibraryDeployer } from '../wrappers/library-deployer';

export async function run(provider: NetworkProvider) {
    /* const library: SimpleLibrary = {
        public: true,
        root: await compile('wallet_v5')
    };

    let secretKey = process.env.LIBRARY_KEEPER_SECRET_KEY;
    if (!secretKey) {
        const keypair = keyPairFromSeed(await getSecureRandomBytes(32));
        console.log('GENERATED PRIVATE_KEY', keypair.secretKey.toString('hex'));
        secretKey = keypair.secretKey.toString('hex');
        fs.appendFileSync('.env', `LIBRARY_KEEPER_SECRET_KEY=${secretKey}`);
    }

    const keypair = keyPairFromSecretKey(Buffer.from(secretKey, 'hex'));

    const libraryKeeper = provider.open(
        LibraryKeeper.createFromConfig(
            { publicKey: keypair.publicKey, seqno: 0 },
            await compile('library-keeper')
        )
    );

    const isActive = await libraryKeeper.getIsActive();

    if (!isActive) {
        await libraryKeeper.sendDeploy(provider.sender(), toNano('0.1'));
        await provider.waitForDeploy(libraryKeeper.address);
    }

    await libraryKeeper.sendAddLibrary({
        libraryCode: library.root,
        secretKey: keypair.secretKey
    });

    console.log('LIBRARY KEEPER ADDRESS', libraryKeeper.address);*/

    const libraryDeployer = provider.open(
        LibraryDeployer.createFromConfig(
            { libraryCode: await compile('wallet_v5') },
            await compile('library-deployer')
        )
    );

    await libraryDeployer.sendDeploy(provider.sender(), toNano('0.1'));
    await provider.waitForDeploy(libraryDeployer.address);

    console.log('LIBRARY ADDRESS', libraryDeployer.address);
}
