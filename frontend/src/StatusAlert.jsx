import { AlertIcon, CheckIcon } from "./icons";

export default function StatusAlert({ status, className = "" }) {
    if (!status) {
        return null;
    }

    return (
        <div
            className={`alert alert--${status.type} ${className}`.trim()}
            role="status"
        >
            <span className="alert__icon" aria-hidden="true">
                {status.type === "success" ? <CheckIcon /> : <AlertIcon />}
            </span>
            <p>{status.message}</p>
        </div>
    );
}
