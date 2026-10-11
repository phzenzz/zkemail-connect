import { Mail } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: { box: "h-7 w-7", icon: "h-4 w-4" },
  lg: { box: "h-12 w-12", icon: "h-6 w-6" },
} as const;

/** 品牌色即黑（PRD §3.1）——用 primary token，不引彩色。 */
export function LogoMark({ size = "sm", className }: { size?: keyof typeof SIZES; className?: string }) {
  const s = SIZES[size];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground",
        s.box,
        className,
      )}
    >
      <Mail className={s.icon} strokeWidth={2.5} />
    </span>
  );
}

export function Logo({ size = "sm", className }: { size?: keyof typeof SIZES; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <LogoMark size={size} />
      <span className="text-sm font-semibold tracking-tight">zkEmail Connect</span>
    </span>
  );
}
