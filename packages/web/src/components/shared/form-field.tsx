"use client";

import { createContext, type HTMLAttributes, type ReactNode, useContext, useId } from "react";
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

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-item`,
    formDescriptionId: `${id}-description`,
    formMessageId: `${id}-message`,
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

export function FormMessage({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  const { formMessageId, error } = useFormField();
  const body = error ? String(error.message ?? "") : children;
  if (!body) return null;
  return (
    <p id={formMessageId} className={cn("text-xs font-medium text-error", className)} {...props}>
      {body}
    </p>
  );
}
