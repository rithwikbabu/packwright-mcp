package io.github.rithwikbabu.packwright.capture.protocol;

/** A bounded, user-actionable capture protocol failure. */
public final class ProtocolException extends Exception {
    private static final long serialVersionUID = 1L;

    public ProtocolException(String message) {
        super(message);
    }

    public ProtocolException(String message, Throwable cause) {
        super(message, cause);
    }
}
