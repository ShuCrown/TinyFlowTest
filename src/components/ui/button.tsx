import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[9px] text-[13px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-accent/20 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border border-ink bg-ink text-panel hover:border-black hover:bg-black",
        destructive: "border border-danger/25 bg-white text-danger hover:border-danger/45 hover:bg-[#fdf3f0]",
        outline: "border border-line bg-white text-ink hover:border-ink/30 hover:bg-[#fdfcf9]",
        secondary: "border border-line bg-[#f1efe8] text-ink hover:bg-[#e9e6dd]",
        ghost: "border border-transparent text-ink hover:bg-accent-soft/60",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-7 rounded-[7px] px-2.5 text-[11.5px]",
        lg: "h-10 px-5",
        icon: "size-9",
        "icon-sm": "size-7 rounded-[7px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
