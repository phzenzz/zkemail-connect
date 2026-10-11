import { CreditCard, PenLine, Users, type LucideIcon } from "lucide-react";

/** 见 MarketingLayout 的说明：指向 /app/send-claim，由守卫决定是否跳登录。 */
export const LAUNCH_APP = "/app/send-claim";

export type Solution = { slug: string; title: string; blurb: string; icon: LucideIcon };

export const SOLUTIONS: Solution[] = [
  {
    slug: "crm",
    title: "CRM",
    blurb: "Reward and onboard users by email, straight from your CRM.",
    icon: Users,
  },
  {
    slug: "payment",
    title: "Payment",
    blurb: "Settle a payment to an email address instead of a wallet address.",
    icon: CreditCard,
  },
  {
    slug: "esign",
    title: "ESign",
    blurb: "Attach a token transfer to a signed agreement and release it on signature.",
    icon: PenLine,
  },
];
