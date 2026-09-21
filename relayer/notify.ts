export interface NotifyPayload {
  escrow: string;
  sender: string;
  amount: string;
  claimUrl: string;
}

export interface Notifier {
  notify(to: string, p: NotifyPayload): Promise<void>;
}

/** v1 默认实现：打印通知内容。SMTP 实现替换此类即可（保持接口）。 */
export class ConsoleNotifier implements Notifier {
  async notify(to: string, p: NotifyPayload): Promise<void> {
    console.log(`[notify] to=${to} escrow=${p.escrow} amount=${p.amount} sender=${p.sender} claim=${p.claimUrl}`);
  }
}
