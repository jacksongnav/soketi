export class Log {
    static infoTitle(message: any): void {
        this.log(message, '\x1b[1m\x1b[30m\x1b[46m', 'mx-2', 'px-1', '\x1b[0m');
    }

    static successTitle(message: any): void {
        this.log(message, '\x1b[1m\x1b[30m\x1b[42m', 'mx-2', 'px-1', '\x1b[0m');
    }

    static errorTitle(message: any): void {
        this.log(this.prefixWithTime(message), '\x1b[1m\x1b[30m\x1b[41m', 'mx-2', 'px-1', '\x1b[0m');
    }

    static warningTitle(message: any): void {
        this.log(this.prefixWithTime(message), '\x1b[1m\x1b[30m\x1b[43m', 'mx-2', 'px-1', '\x1b[0m');
    }

    static clusterTitle(message: any): void {
        this.log(this.prefixWithTime(message), '\x1b[1m\x1b[33m\x1b[45m', 'mx-2', 'px-1', '\x1b[0m');
    }

    static httpTitle(message: any): void {
        this.infoTitle(this.prefixWithTime(message));
    }

    static discoverTitle(message: any): void {
        this.log(this.prefixWithTime(message), '\x1b[1m\x1b[90m\x1b[106m', 'mx-2', 'px-1', '\x1b[0m');
    }

    static websocketTitle(message: any): void {
        this.successTitle(this.prefixWithTime(message));
    }

    static webhookSenderTitle(message: any): void {
        this.log(this.prefixWithTime(message), '\x1b[1m\x1b[34m\x1b[47m', 'mx-2', 'px-1', '\x1b[0m');
    }

    static info(message: any): void {
        this.log(message, '\x1b[36m', 'mx-2', '\x1b[0m');
    }

    static success(message: any): void {
        this.log(message, '\x1b[32m', 'mx-2', '\x1b[0m');
    }

    static error(message: any): void {
        this.log(message, '\x1b[31m', 'mx-2', '\x1b[0m');
    }

    static warning(message: any): void {
        this.log(message, '\x1b[33m', 'mx-2', '\x1b[0m');
    }

    static cluster(message: any): void {
        this.log(message, '\x1b[1m\x1b[35m', 'mx-2', '\x1b[0m');
    }

    static http(message: any): void {
        this.info(message);
    }

    static discover(message: any): void {
        this.log(message, '\x1b[1m\x1b[96m', 'mx-2', '\x1b[0m');
    }

    static websocket(message: any): void {
        this.success(message);
    }

    static webhookSender(message: any): void {
        this.log(message, '\x1b[1m\x1b[37m', 'mx-2', '\x1b[0m');
    }

    static br(): void {
        console.log('');
    }

    protected static prefixWithTime(message: any): any {
        if (typeof message === 'string') {
            return '[' + (new Date).toString() + '] ' + message;
        }

        return message;
    }

    protected static log(message: any, ...styles: string[]): void {
        let coloredMessage = '';
        let resetCode = '\x1b[0m'; // Default reset

        if (typeof message !== 'string') {
            return console.log(message);
        }

        const colorCodes = styles.filter(style => !/^m?x-/.test(style));
        const marginCodes = styles.filter(style => /^mx-/.test(style));
        const paddingCodes = styles.filter(style => /^px-/.test(style));

        let preColor = '';
        let postColor = '';

        colorCodes.forEach((code) => {
            if(code === '\x1b[0m'){
                resetCode = code;
            } else {
                preColor += code;
            }
        });

        const applyMargins = (msg: string): string => {
            const spaces = marginCodes
                .map(style => ' '.repeat(parseInt(style.substr(3))))
                .join('');
            return spaces + msg + spaces;
        };

        const applyPadding = (msg: string): string => {
            const spaces = paddingCodes
                .map(style => ' '.repeat(parseInt(style.substr(3))))
                .join('');
            return spaces + msg + spaces;
        };

        coloredMessage = preColor + applyPadding(message) + resetCode;
        console.log(applyMargins(coloredMessage));
    }
}