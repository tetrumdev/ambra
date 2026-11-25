import { useState, type ReactNode } from "react";
import { StyleSheet, Text, TextInput, type TextInputProps, type ViewStyle } from "react-native";
import { Touchable } from "./Touchable";
import { colors, fonts, radius, sizes, space, textSize } from "./theme";

type ButtonProps = Omit<React.ComponentProps<typeof Touchable>, "children"> & {
  title: string;
  children?: ReactNode;
  variant?: "secondary" | "primary" | "destructive";
};

export function Button({ title, children, variant = "secondary", style, ...props }: ButtonProps) {
  return (
    <Touchable {...props} accessibilityRole="button" accessibilityLabel={props.accessibilityLabel ?? title}
      style={[styles.button, styles[variant], style]}>
      {children ?? <Text style={[styles.buttonLabel, variant === "primary" && styles.inverseLabel]}>{title}</Text>}
    </Touchable>
  );
}

type FieldProps = TextInputProps & {
  bare?: boolean;
};

export function Field({ bare, onFocus, onBlur, style, ...props }: FieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      keyboardAppearance="dark"
      placeholderTextColor={colors.faint}
      selectionColor={colors.accent}
      {...props}
      style={[styles.inputText, !bare && styles.field, style, !bare && focused && styles.focus]}
      onFocus={event => {
        if (!bare) setFocused(true);
        onFocus?.(event);
      }}
      onBlur={event => {
        if (!bare) setFocused(false);
        onBlur?.(event);
      }}
    />
  );
}

export const fieldFrame = {
  minHeight: sizes.field,
  borderRadius: radius.field,
  borderWidth: 1,
  borderColor: colors.control,
  backgroundColor: colors.field,
} satisfies ViewStyle;

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: sizes.touch,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  secondary: { borderColor: colors.control, backgroundColor: colors.raised },
  primary: { borderColor: colors.text, backgroundColor: colors.text },
  destructive: { borderColor: "transparent", backgroundColor: colors.destructive },
  buttonLabel: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.small, fontWeight: "600", textAlign: "center" },
  inverseLabel: { color: colors.black },
  inputText: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.body },
  field: { ...fieldFrame, paddingHorizontal: space.md, paddingVertical: space.sm },
  focus: { borderColor: colors.accent },
});
