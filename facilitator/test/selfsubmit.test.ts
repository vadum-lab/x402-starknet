/**
 * Black-box tests of the self-submit facilitator: the real selfsubmit.ts runs in a child process
 * against a fake Starknet JSON-RPC node on localhost. No network, no real keys.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSET = '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const PAY_TO = '0x2dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57';
const PAYER = '0x3f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24';
const FACILITATOR = '0x5f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81';
const TRANSFER_SELECTOR = '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e';
const TX_HASH = '0xabc';
const PRICE = 1000n;

let executionStatus = 'SUCCEEDED';

const FEE = {
  l1_gas_consumed: '0x1', l1_gas_price: '0x1', l2_gas_consumed: '0x1', l2_gas_price: '0x1',
  l1_data_gas_consumed: '0x1', l1_data_gas_price: '0x1', overall_fee: '0x3', unit: 'FRI',
};
const BLOCK = {
  status: 'ACCEPTED_ON_L2', block_hash: '0x2', parent_hash: '0x1', block_number: 1, new_root: '0x1', timestamp: 1,
  sequencer_address: '0x1', starknet_version: '0.14.0', l1_da_mode: 'BLOB',
  l1_gas_price: { price_in_fri: '0x1', price_in_wei: '0x1' },
  l2_gas_price: { price_in_fri: '0x1', price_in_wei: '0x1' },
  l1_data_gas_price: { price_in_fri: '0x1', price_in_wei: '0x1' },
  transactions: [],
};

function rpcResult(method: string, params: any): unknown {
  switch (method) {
    case 'starknet_specVersion': return '0.9.0';
    case 'starknet_chainId': return '0x534e5f5345504f4c4941';
    case 'starknet_getNonce': return '0x0';
    case 'starknet_getClassHashAt': return '0x1';
    case 'starknet_getClassAt':
      return {
        sierra_program: ['0x1'], contract_class_version: '0.1.0', abi: '[]',
        entry_points_by_type: { CONSTRUCTOR: [], EXTERNAL: [], L1_HANDLER: [] },
      };
    case 'starknet_call': return [`0x${(10n ** 21n).toString(16)}`, '0x0'];
    case 'starknet_estimateFee': return params.request.map(() => FEE);
    case 'starknet_getBlockWithTxs':
    case 'starknet_getBlockWithTxHashes': return BLOCK;
    case 'starknet_addInvokeTransaction': return { transaction_hash: TX_HASH };
    case 'starknet_getTransactionStatus':
      return { finality_status: 'ACCEPTED_ON_L2', execution_status: executionStatus };
    case 'starknet_getTransactionReceipt':
      return {
        type: 'INVOKE', transaction_hash: TX_HASH, finality_status: 'ACCEPTED_ON_L2', execution_status: executionStatus,
        ...(executionStatus === 'REVERTED' ? { revert_reason: 'u256_sub Overflow' } : {}),
        actual_fee: { amount: '0x3', unit: 'FRI' }, messages_sent: [], events: [],
        execution_resources: { l1_gas: 0, l2_gas: 0, l1_data_gas: 0 }, block_hash: '0x2', block_number: 1,
      };
    default: throw new Error(`unexpected RPC method: ${method}`);
  }
}

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

function outsideTransaction(amount: bigint) {
  return {
    outsideExecution: {
      caller: FACILITATOR, nonce: '0x7', execute_after: '0x1',
      execute_before: `0x${(Math.floor(Date.now() / 1000) + 300).toString(16)}`,
      calls: [{ to: ASSET, selector: TRANSFER_SELECTOR, calldata: [PAY_TO, `0x${amount.toString(16)}`, '0x0'] }],
    },
    signature: ['0x1', '0x2'], signerAddress: PAYER, version: '2',
  };
}

const requirements = (overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact', asset: ASSET, payTo: PAY_TO, amount: PRICE.toString(), maxTimeoutSeconds: 300, ...overrides,
});

/** A signed amount and a declared amount, which an honest client keeps equal. */
function body(signed: bigint, declared: bigint = signed, reqs: unknown = requirements()) {
  return {
    payload: {
      payload: {
        authorization: { from: PAYER, amount: declared.toString() },
        outsideTransaction: outsideTransaction(signed),
      },
    },
    requirements: reqs,
  };
}

describe('self-submit facilitator', () => {
  let rpc: Server;
  let child: ChildProcess;
  let base: string;
  let logs = '';

  const post = async (path: string, payload: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return res.json();
  };

  before(async () => {
    rpc = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const { id, method, params } = JSON.parse(raw);
        res.setHeader('content-type', 'application/json');
        try {
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result: rpcResult(method, params) }));
        } catch (e) {
          logs += `${(e as Error).message}\n`;
          res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: (e as Error).message } }));
        }
      });
    });
    const rpcPort = await listen(rpc);

    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    base = `http://127.0.0.1:${port}`;

    const cwd = join(dirname(fileURLToPath(import.meta.url)), '..');
    child = spawn(process.execPath, ['--import', 'tsx', 'selfsubmit.ts'], {
      cwd,
      env: {
        ...process.env, PORT: String(port), STARKNET_RPC_URL: `http://127.0.0.1:${rpcPort}`,
        X402_ASSET: ASSET, X402_PAY_TO: PAY_TO, FACILITATOR_ADDRESS: FACILITATOR, FACILITATOR_PRIVATE_KEY: '0x1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d) => (logs += d));
    child.stderr!.on('data', (d) => (logs += d));

    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch { /* not listening yet */ }
      if (i > 150) throw new Error(`facilitator did not start:\n${logs}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  after(async () => {
    child?.kill();
    await new Promise((r) => rpc.close(r));
  });

  beforeEach(() => { executionStatus = 'SUCCEEDED'; });

  describe('routes of the registered scheme', () => {
    it('announces the executor as feePayer at GET /supported', async () => {
      const out: any = await (await fetch(`${base}/supported`)).json();
      assert.equal(out.kinds[0].network, 'starknet:SN_SEPOLIA');
      assert.equal(BigInt(out.kinds[0].extra.feePayer), BigInt(FACILITATOR));
    });

    it('refuses the pre-scheme /verify body without touching the chain', async () => {
      const out = await post('/verify', body(PRICE));
      assert.equal(out.isValid, false);
      assert.equal(out.invalidReason, 'invalid_payload');
    });

    it('fails closed on an empty /verify body', async () => {
      const res = await fetch(`${base}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal((await res.json() as any).isValid, false);
    });
  });

  describe('/settle', () => {
    it('refuses the pre-scheme body with the registered response shape, broadcasting nothing', async () => {
      const out = await post('/settle', body(PRICE));
      assert.equal(out.success, false);
      assert.equal(out.errorReason, 'invalid_payload');
      assert.equal(out.transaction, '');
      assert.equal(out.network, 'starknet:SN_SEPOLIA');
    });
  });
});
