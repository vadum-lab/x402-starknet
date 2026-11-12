/** rpcChain against a fake JSON-RPC node: what starknet.js really hands back for receipts. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Account, RpcProvider } from 'starknet';
import { Unavailable, rpcChain, type Chain } from '../chain.js';

const HASH = '0xabc';
const EVENT = { from_address: '0xa', keys: ['0x1', '0x2', '0x3'], data: ['0x5', '0x0'] };
const receipt = (o: Record<string, unknown>) => ({
  type: 'INVOKE', transaction_hash: HASH, actual_fee: { amount: '0x3', unit: 'FRI' }, messages_sent: [],
  execution_resources: { l1_gas: 0, l2_gas: 0, l1_data_gas: 0 }, block_hash: '0x2', ...o,
});

let script: Array<() => unknown> = [];
let server: Server;
let chain: Chain;

describe('rpcChain.waitForReceipt', () => {
  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const { id, method } = JSON.parse(raw);
        res.setHeader('content-type', 'application/json');
        if (method === 'starknet_specVersion') return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0.9.0' }));
        if (method !== 'starknet_getTransactionReceipt') {
          return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: method } }));
        }
        const next = script.shift() ?? (() => ({ error: { code: 29, message: 'Transaction hash not found' } }));
        res.end(JSON.stringify({ jsonrpc: '2.0', id, ...(next() as object) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const provider = new RpcProvider({ nodeUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    chain = rpcChain(provider, new Account({ provider, address: '0x1', signer: '0x1' }), 5);
  });
  after(() => new Promise((r) => server.close(r)));

  it('waits through not-found and pre-confirmed receipts, then returns status and events', async () => {
    script = [
      () => ({ error: { code: 29, message: 'Transaction hash not found' } }),
      () => ({ result: receipt({ finality_status: 'PRE_CONFIRMED', execution_status: 'SUCCEEDED', events: [] }) }),
      () => ({ result: receipt({ finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED', block_number: 7, events: [EVENT] }) }),
    ];
    const r = await chain.waitForReceipt(HASH, 2000);
    assert.equal(r.executionStatus, 'SUCCEEDED');
    assert.deepEqual(r.events, [EVENT]);
  });

  it('returns a reverted receipt as an outcome', async () => {
    script = [() => ({ result: receipt({ finality_status: 'ACCEPTED_ON_L2', execution_status: 'REVERTED', revert_reason: 'x', block_number: 7, events: [] }) })];
    assert.equal((await chain.waitForReceipt(HASH, 2000)).executionStatus, 'REVERTED');
  });

  it('gives up with Unavailable when no outcome comes before the deadline', async () => {
    script = [];
    await assert.rejects(chain.waitForReceipt(HASH, 30), Unavailable);
  });

  it('turns a node failure into Unavailable, never an outcome', async () => {
    script = [() => ({ error: { code: 500, message: 'boom' } })];
    await assert.rejects(chain.waitForReceipt(HASH, 2000), Unavailable);
  });
});
