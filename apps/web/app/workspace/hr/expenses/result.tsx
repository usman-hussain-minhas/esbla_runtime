"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";

export function ExpenseResult({
  message,
  success,
}: Readonly<{ message: string; success: boolean }>) {
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => result.current?.focus(), []);
  return (
    <div
      className={success ? "success-banner" : "form-error-summary"}
      id="expense-result"
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
