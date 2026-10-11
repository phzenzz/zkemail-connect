// relayer 存储层接口：上层（indexer/inbound/claimer）只依赖本接口。
// 本地实现见 ./sqlite（better-sqlite3）；生产目标 Cloudflare D1，届时新增 d1.ts 实现同一接口。
export interface BatchCache {
  batch: string; // base58
  root: string; // hex
  emails: string[];
}

export interface RelayerStore {
  listBatches(): Promise<BatchCache[]>;
  saveBatch(c: BatchCache): Promise<void>;
  removeBatch(address: string): Promise<void>;
  wasEscrowNotified(escrowAddr: string): Promise<boolean>;
  wasBatchRecipientNotified(batchAddr: string, leafIndex: number): Promise<boolean>;
  markEscrowNotified(escrowAddr: string, recipient: string): Promise<void>;
  markBatchRecipientNotified(batchAddr: string, leafIndex: number, recipient: string): Promise<void>;
  removeNotifiedForBatch(batchAddr: string): Promise<void>;
  close(): void;
}
