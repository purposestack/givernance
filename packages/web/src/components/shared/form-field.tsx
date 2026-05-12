"use client";

import { Slot } from "@radix-ui/react-slot";
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useId,
} from "react";
import {
  Controller,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
  FormProvider,
  useFormContext,
} from "react-hook-form";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export const Form = FormProvider;

interface FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  name: TName;
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null);

interface FormItemContextValue {
  id: string;
}

const FormItemContext = createContext<FormItemContextValue | null>(null);

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({ ...props }: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

export function useFormField() {
  const fieldContext = useContext(FormFieldContext);
  const itemContext = useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();

  if (!fieldContext) {
    throw new Error("useFormField must be used inside <FormField>");
  }
  if (!itemContext) {
    throw new Error("useFormField must be used inside <FormItem>");
  }

  const fieldState = getFieldState(fieldContext.name, formState);
  const { id } = itemContext;
  const { error } = fieldState;

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-item`,
    formDescriptionId: `${id}-description`,
    formMessageId: `${id}-message`,
    ariaDescribedBy: error ? `${id}-description ${id}-message` : `${id}-description`,
    ...fieldState,
  };
}

export function FormItem({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const id = useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div className={cn("space-y-1.5", className)} {...props} />
    </FormItemContext.Provider>
  );
}

export function FormLabel({
  className,
  children,
  required,
}: {
  className?: string;
  children: ReactNode;
  required?: boolean;
}) {
  const { formItemId, error } = useFormField();
  return (
    <Label
      htmlFor={formItemId}
      required={required}
      className={cn(error && "text-error", className)}
    >
      {children}
    </Label>
  );
}

export function FormDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  const { formDescriptionId } = useFormField();
  return (
    <p
      id={formDescriptionId}
      className={cn("text-xs text-on-surface-variant", className)}
      {...props}
    />
  );
}

export function FormControl(props: ComponentProps<typeof Slot>) {
  const { formItemId, formDescriptionId, formMessageId, ariaDescribedBy, error } = useFormField();

  return (
    <Slot
      id={formItemId}
      aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : ariaDescribedBy}
      aria-invalid={Boolean(error)}
      {...props}
    />
  );
}

export function FormMessage({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  const { formMessageId, error } = useFormField();
  const body = error ? String(error.message ?? "") : children;
  // Always mount the live region — even when empty. Several screen-reader
  // combinations (NVDA + Firefox in particular) skip the announcement
  // when the element mounts together with its content in the same tick;
  // keeping the node in the DOM with a stable id turns the AT
  // notification into a *content change* on a known region, which is
  // reliably announced on every error → clear → re-error cycle.
  //
  // `aria-live="polite"` is the default — the assertive level would
  // pre-empt any concurrent `role=alert` rootError summary (used on the
  // signup / new-tenant / donation / etc. forms) and turn submit-with-
  // errors into a flood that drowns the curated summary. Call sites
  // that need to interrupt the user (payment failure, session expiry)
  // can override `aria-live` via the spread props.
  return (
    <p
      id={formMessageId}
      role="status"
      aria-live="polite"
      className={cn(
        "text-xs font-medium text-error",
        // Reserve the row when empty so screen readers see content
        // changes on a stable region; visually hidden when there's
        // nothing to read.
        !body && "sr-only",
        className,
      )}
      {...props}
    >
      {body}
    </p>
  );
}
