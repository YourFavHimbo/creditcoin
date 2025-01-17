import { parseAmountInternal } from "../../utils/parsing";
import { signSendAndWatch } from "../../utils/tx";
import { fundFromSudo, randomTestAccount } from "./helpers";
import { arg, retry, setArgIfUndef, setAuthorities } from "../../globalSetup";
import execa from "execa";
import {
  Blockchain,
  CreditcoinApi,
  KeyringPair,
  Wallet,
  creditcoinApi,
  providers,
} from "creditcoin-js";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { deployCtcContract, CREDO_PER_CTC } from "creditcoin-js/lib/ctc-deploy";
import {
  testData,
  tryRegisterAddress,
  forElapsedBlocks,
} from "creditcoin-js/lib/testUtils";
import { describeIf } from "../../utils/tests";
import { getBalance } from "../../utils/balance";

describeIf(arg("CREDITCOIN_EXECUTE_SETUP_AUTHORITY"), "collect-coins", () => {
  let ccApi: CreditcoinApi;
  let sudo: KeyringPair;
  let caller: any;

  const { keyring, blockchain } = testData(
    arg("CREDITCOIN_ETHEREUM_CHAIN") as Blockchain,
    arg("CREDITCOIN_CREATE_WALLET"),
  );

  beforeAll(async () => {
    // will deploy the contract and burn 3 CTC
    await deployCtcContract(
      (global as any).CREDITCOIN_CTC_CONTRACT_ADDRESS,
      (global as any).CREDITCOIN_ETHEREUM_NODE_URL,
      (global as any).CREDITCOIN_CTC_DEPLOYER_PRIVATE_KEY,
      (3 * CREDO_PER_CTC).toString(),
    );
    setArgIfUndef(
      "CREDITCOIN_CTC_CONTRACT_ADDRESS",
      process.env.CREDITCOIN_CTC_CONTRACT_ADDRESS,
    );
    setArgIfUndef(
      "CREDITCOIN_CTC_BURN_TX_HASH",
      process.env.CREDITCOIN_CTC_BURN_TX_HASH,
    );

    try {
      await retry(5, setAuthorities);
    } catch (reason: any) {
      console.log(`Could not setup testing authorities: ${reason as string}`);
      process.exit(1);
    }

    await cryptoWaitReady();

    caller = randomTestAccount(false);

    ccApi = await creditcoinApi((global as any).CREDITCOIN_API_URL);
    sudo = arg("CREDITCOIN_CREATE_SIGNER")(keyring, "sudo");

    const { api } = ccApi;

    /* eslint-disable @typescript-eslint/naming-convention */
    const contract = api.createType(
      "PalletCreditcoinOcwTasksCollectCoinsDeployedContract",
      {
        address: (global as any).CREDITCOIN_CTC_CONTRACT_ADDRESS,
        chain: blockchain,
      },
    );

    await api.tx.sudo
      .sudo(api.tx.creditcoin.setCollectCoinsContract(contract))
      .signAndSend(sudo, { nonce: -1 });
  }, 100_000);

  afterAll(async () => {
    await ccApi.api.disconnect();
  });

  test("e2e", async () => {
    const {
      api,
      utils: { signAccountId },
    } = ccApi;

    const provider = new providers.JsonRpcProvider(
      arg("CREDITCOIN_ETHEREUM_NODE_URL"),
    );
    const deployerWallet = new Wallet(
      arg("CREDITCOIN_CTC_DEPLOYER_PRIVATE_KEY"),
      provider,
    );

    const fundTx = await fundFromSudo(
      caller.address,
      parseAmountInternal("5"),
      arg("CREDITCOIN_API_URL"),
    );
    await signSendAndWatch(fundTx, api, sudo);

    await tryRegisterAddress(
      ccApi,
      deployerWallet.address,
      blockchain,
      signAccountId(deployerWallet, caller.address),
      caller.keyring,
      (global as any).CREDITCOIN_REUSE_EXISTING_ADDRESSES,
    );

    // Read balance after register address call but prior to collect coins
    const starting = await getBalance(caller.address, api);

    const url = arg("CREDITCOIN_API_URL") as string;
    const txHash = arg("CREDITCOIN_CTC_BURN_TX_HASH") as string;
    const collectResult = execa.commandSync(
      `node dist/index.js collect-coins --url ${url} --external-address ${deployerWallet.address} --burn-tx-hash ${txHash}`,
      {
        env: {
          CC_SECRET: caller.secret,
        },
      },
    );

    const collectOutput = collectResult.stdout.split("\n");
    expect(collectResult.failed).toBe(false);
    expect(collectResult.exitCode).toBe(0);
    expect(collectResult.stderr).toBe("");
    expect(collectOutput[collectOutput.length - 1]).toBe("Success!");

    // wait for 2 more blocks
    await forElapsedBlocks(api);

    // read the balance after collect coins
    const ending = await getBalance(caller.address, api);

    // note: these are of type BN and .toBeGreaterThan() doesn't work
    expect(ending.total > starting.total).toBe(true);
  }, 900_000);
});
