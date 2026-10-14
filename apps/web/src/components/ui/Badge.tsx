import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "bg-slate-100 text-slate-700",
      success: "bg-green-100 text-green-800",
      warning: "bg-amber-100 text-amber-800",
      destructive: "bg-red-100 text-red-800",
      info: "bg-blue-100 text-blue-800",
      outline: "border border-slate-200 bg-white text-slate-600",
      destructiveOutline: "border border-red-200 bg-white text-red-700",
      processing: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
export default Badge;
