import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-[76px] w-full resize-y rounded-[9px] border border-line bg-white px-3 py-2 text-[13px] leading-6 text-ink transition-[border-color,box-shadow] outline-none placeholder:text-muted/65 focus-visible:border-accent/55 focus-visible:ring-[3px] focus-visible:ring-accent/10 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
