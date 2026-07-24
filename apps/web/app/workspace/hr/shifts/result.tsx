"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";

interface Props {
  readonly message: string;
  readonly success: boolean;
}

export function ShiftResult({ message, success }: Props) {
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => result.current?.focus(), []);
  return (
    <div
      className={success ? "success-banner" : "form-error-summary"}
      id="shift-result"
      ref={result}
      role={success ? "status" : "alert"}
      tabIndex={-1}
    >
      {success ? (
        <CircleCheck aria-hidden="true" size={20} />
      ) : (
        <TriangleAlert aria-hidden="true" size={20} />
      )}
      <p>{message}</p>
    </div>
  );
}
