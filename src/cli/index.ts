import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Cli } from './cli.js';

const argv = yargs(hideBin(process.argv))
    .usage('Usage: soketi <command> [options]')
    .command(
        'start',
        'Start the server.',
        (yargs) => {
            return yargs.option('config', { describe: 'The path for the config file. (optional)' });
        },
        (argv) => Cli.start(argv)
    )
    .demandCommand(1, 'Please provide a valid command.')
    .help('help')
    .alias('help', 'h')
    .parse();