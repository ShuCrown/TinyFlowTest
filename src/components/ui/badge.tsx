import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit items-center justify-center gap-1 whitespace-nowrap rounded-full border px-2 py-[3px] font-mono text-[10.5px] leading-tight transition-colors [&>svg]:size-3 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-line bg-white text-ink hover:bg-white",
        secondary: "border-line bg-ink/[0.03] text-muted",
        accent: "border-accent/20 bg-accent-soft text-accent",
        moss: "border-moss/20 bg-moss-soft text-moss",
        amber: "border-amber/20 bg-amber-soft text-amber",
        destructive: "border-danger/20 bg-[#fdf3f0] text-danger",
        outline: "border-line bg-transparent text-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
