import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-[9px] border border-line bg-white px-3 py-1 text-[13px] text-ink transition-[border-color,box-shadow] outline-none placeholder:text-muted/65 focus-visible:border-accent/55 focus-visible:ring-[3px] focus-visible:ring-accent/10 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
