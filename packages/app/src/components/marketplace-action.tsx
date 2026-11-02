import { Show, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"

export function MarketplaceAction(props: {
  v2?: boolean
  disabled?: boolean
  label?: string
  pressed?: boolean
  type?: "button" | "submit"
  onClick?: () => void
  children: JSX.Element
}) {
  return (
    <Show
      when={props.v2}
      fallback={
        <Button
          size="small"
          variant={props.pressed ? "primary" : "secondary"}
          type={props.type ?? "button"}
          disabled={props.disabled}
          aria-label={props.label}
          aria-pressed={props.pressed}
          onClick={props.onClick}
        >
          {props.children}
        </Button>
      }
    >
      <ButtonV2
        size="small"
        variant={props.pressed ? "contrast" : "outline"}
        type={props.type ?? "button"}
        disabled={props.disabled}
        aria-label={props.label}
        aria-pressed={props.pressed}
        onClick={props.onClick}
      >
        {props.children}
      </ButtonV2>
    </Show>
  )
}
