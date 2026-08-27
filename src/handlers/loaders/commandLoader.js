import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';
import { disabledCommands } from '../../config/disabledCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;

/**
 * Obtiene los subcomandos de un comando.
 */
function getSubcommandInfo(commandData) {
    const subcommands = [];

    if (!commandData.options) {
        return subcommands;
    }

    for (const option of commandData.options) {
        // Subcomando normal
        if (option.type === 1) {
            subcommands.push(option.name);
        }

        // Grupo de subcomandos
        else if (option.type === 2 && option.options) {
            for (const subOption of option.options) {
                if (subOption.type === 1) {
                    subcommands.push(`${option.name}/${subOption.name}`);
                }
            }
        }
    }

    return subcommands;
}

/**
 * Busca todos los archivos .js dentro de /commands.
 */
async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, { withFileTypes: true });

    for (const file of files) {
        const filePath = path.join(directory, file.name);

        if (file.isDirectory()) {
            // No cargar comandos internos de modules
            if (file.name === 'modules') {
                continue;
            }

            await getAllFiles(filePath, fileList);
        }

        else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }

    return fileList;
}

/**
 * Carga todos los comandos activos.
 *
 * Los comandos incluidos en disabledCommands NO se cargan,
 * pero permanecen físicamente en el proyecto para poder
 * activarlos posteriormente.
 */
export async function loadCommands(client) {
    client.commands = new Collection();

    const commandsPath = path.join(__dirname, '../../commands');
    const commandFiles = await getAllFiles(commandsPath);

    logger.info(`Found ${commandFiles.length} command files to load`);

    const uniqueCommandNames = new Set();

    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');

            const commandName = path.basename(filePath, '.js');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);

            // ==========================================
            // COMANDO DESACTIVADO
            // ==========================================
            if (disabledCommands.has(commandName)) {
                logger.info(
                    `Skipping disabled command: ${commandName}`
                );

                continue;
            }

            // ==========================================
            // CARGAR COMANDO
            // ==========================================
            const commandModule = await import(
                `file://${filePath}`
            );

            const command = commandModule.default || commandModule;

            // Verificar estructura del comando
            if (!command.data || !command.execute) {
                logger.warn(
                    `Command at ${filePath} is missing required "data" or "execute" property.`
                );

                continue;
            }

            command.category = category;
            command.filePath = normalizedPath;

            const primaryCommandName = command.data.name;

            // Evitar comandos duplicados
            if (uniqueCommandNames.has(primaryCommandName)) {
                logger.warn(
                    `Duplicate command detected: ${primaryCommandName}`
                );

                continue;
            }

            uniqueCommandNames.add(primaryCommandName);

            client.commands.set(
                primaryCommandName,
                command
            );

            // Obtener subcomandos
            const subcommands = getSubcommandInfo(
                command.data.toJSON()
            );

            logger.info(
                `Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${category})`
            );

            if (subcommands.length > 0) {
                logger.info(
                    `  - Subcommands: ${subcommands.join(', ')}`
                );
            }

        } catch (error) {
            logger.error(
                `Error loading command from ${filePath}:`,
                error
            );
        }
    }

    logger.info(
        `Loaded ${client.commands.size} active commands`
    );

    return client.commands;
}

/**
 * Prepara los comandos para registrarlos en Discord.
 */
function collectCommandPayloads(client) {
    const commands = [];
    let totalSubcommands = 0;

    const registeredNames = new Set();

    for (const command of client.commands.values()) {

        if (
            !command.data ||
            typeof command.data.toJSON !== 'function'
        ) {
            logger.warn(
                `Command missing data or toJSON method: ${command}`
            );

            continue;
        }

        const commandName = command.data.name;

        // Evitar duplicados
        if (registeredNames.has(commandName)) {
            logger.debug(
                `Skipping duplicate command: ${commandName}`
            );

            continue;
        }

        registeredNames.add(commandName);

        const commandJson = command.data.toJSON();

        commands.push(commandJson);

        totalSubcommands += getSubcommandInfo(
            commandJson
        ).length;

        if (process.env.NODE_ENV !== 'production') {
            logger.debug(
                `Registering command: ${commandName}`
            );
        }
    }

    return {
        commands,
        totalSubcommands
    };
}

/**
 * Valida los comandos antes de registrarlos.
 */
function validateCommands(commands) {
    const validationErrors = [];

    for (const cmd of commands) {

        // Nombre del comando
        if (cmd.name && cmd.name.length > 32) {
            validationErrors.push(
                `Command ${cmd.name} has name longer than 32 chars: "${cmd.name}" (${cmd.name.length} chars)`
            );
        }

        // Descripción
        if (cmd.description && cmd.description.length > 110) {
            validationErrors.push(
                `Command ${cmd.name} has description longer than 110 chars: "${cmd.description}" (${cmd.description.length} chars)`
            );
        }

        if (!cmd.options) {
            continue;
        }

        for (const option of cmd.options) {

            // Nombre de opción
            if (option.name && option.name.length > 32) {
                validationErrors.push(
                    `Command ${cmd.name} option ${option.name} has name longer than 32 chars: "${option.name}" (${option.name.length} chars)`
                );
            }

            // Descripción de opción
            if (
                option.description &&
                option.description.length > 110
            ) {
                validationErrors.push(
                    `Command ${cmd.name} option ${option.name} has description longer than 110 chars: "${option.description}" (${option.description.length} chars)`
                );
            }

            // Choices
            if (option.choices) {
                for (const choice of option.choices) {

                    if (
                        choice.name &&
                        choice.name.length > 110
                    ) {
                        validationErrors.push(
                            `Command ${cmd.name} option ${option.name} choice ${choice.name} has name longer than 110 chars: "${choice.name}" (${choice.name.length} chars)`
                        );
                    }

                    if (
                        choice.value &&
                        typeof choice.value === 'string' &&
                        choice.value.length > 100
                    ) {
                        validationErrors.push(
                            `Command ${cmd.name} option ${option.name} choice ${choice.name} has value longer than 100 chars: "${choice.value}" (${choice.value.length} chars)`
                        );
                    }
                }
            }

            if (!option.options) {
                continue;
            }

            // Subcomandos
            for (const subOption of option.options) {

                if (
                    subOption.name &&
                    subOption.name.length > 32
                ) {
                    validationErrors.push(
                        `Command ${cmd.name} subcommand ${option.name} option ${subOption.name} has name longer than 32 chars: "${subOption.name}" (${subOption.name.length} chars)`
                    );
                }

                if (
                    subOption.description &&
                    subOption.description.length > 110
                ) {
                    validationErrors.push(
                        `Command ${cmd.name} subcommand ${option.name} option ${subOption.name} has description longer than 110 chars: "${subOption.description}" (${subOption.description.length} chars)`
                    );
                }

                if (!subOption.choices) {
                    continue;
                }

                for (const choice of subOption.choices) {

                    if (
                        choice.name &&
                        choice.name.length > 110
                    ) {
                        validationErrors.push(
                            `Command ${cmd.name} subcommand ${option.name} option ${subOption.name} choice ${choice.name} has name longer than 110 chars: "${choice.name}" (${choice.name.length} chars)`
                        );
                    }

                    if (
                        choice.value &&
                        typeof choice.value === 'string' &&
                        choice.value.length > 100
                    ) {
                        validationErrors.push(
                            `Command ${cmd.name} subcommand ${option.name} option ${subOption.name} choice ${choice.name} has value longer than 100 chars: "${choice.value}" (${choice.value.length} chars)`
                        );
                    }
                }
            }
        }
    }

    if (validationErrors.length > 0) {

        logger.error(
            'Command validation failed. Errors:'
        );

        validationErrors.forEach(error => {
            logger.error(`  - ${error}`);
        });

        throw new Error(
            `Command validation failed with ${validationErrors.length} errors`
        );
    }
}

/**
 * Comprueba el límite de comandos de Discord.
 */
function prepareCommandsForRegistration(commands) {

    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(
            `Command count (${commands.length}) is near Discord's ${MAX_COMMANDS} global command limit`
        );
    }

    if (commands.length <= MAX_COMMANDS) {
        return commands;
    }

    logger.warn(
        `Command count (${commands.length}) exceeds Discord limit (${MAX_COMMANDS}), truncating...`
    );

    const truncated = commands.slice(
        0,
        MAX_COMMANDS
    );

    logger.info(
        `Truncated to ${truncated.length} commands for registration`
    );

    return truncated;
}

/**
 * Registra los comandos globalmente en Discord.
 */
async function registerGlobalCommands(
    client,
    clientId,
    commands,
    totalSubcommands
) {

    if (!clientId) {
        throw new Error(
            'CLIENT_ID is required for slash command registration'
        );
    }

    if (!client.rest) {
        throw new Error(
            'Discord REST client is not available for slash command registration'
        );
    }

    logger.info(
        `Preparing to register ${totalSubcommands + commands.length} commands globally`
    );

    logger.info(
        'Validating commands before registration...'
    );

    validateCommands(commands);

    logger.info(
        'Command validation passed'
    );

    const commandsToRegister =
        prepareCommandsForRegistration(commands);

    // Limpiar comandos anteriores si está activado
    if (botConfig.commands?.deleteCommands) {

        logger.info(
            'Clearing existing global commands before registration...'
        );

        await client.rest.put(
            `/applications/${clientId}/commands`,
            {
                body: []
            }
        );
    }

    logger.info(
        `Registering ${commandsToRegister.length} global commands...`
    );

    await client.rest.put(
        `/applications/${clientId}/commands`,
        {
            body: commandsToRegister
        }
    );

    logger.info(
        `Successfully registered ${commandsToRegister.length} global commands`
    );

    logger.info(
        'Global commands may take up to an hour to appear in all servers on first deploy'
    );
}

/**
 * Registra todos los comandos.
 */
export async function registerCommands(
    client,
    options = {}
) {

    const {
        clientId = null
    } = options;

    try {

        const {
            commands,
            totalSubcommands
        } = collectCommandPayloads(client);

        await registerGlobalCommands(
            client,
            clientId,
            commands,
            totalSubcommands
        );

    } catch (error) {

        logger.error(
            'Error registering commands:',
            error
        );

        throw error;
    }
}

/**
 * Recarga un comando sin reiniciar todo el bot.
 */
export async function reloadCommand(
    client,
    commandName
) {

    const command =
        client.commands.get(commandName);

    if (!command) {
        return {
            success: false,
            message: `Command "${commandName}" not found`
        };
    }

    try {

        const commandPath =
            path.resolve(command.filePath);

        const moduleUrl =
            pathToFileURL(commandPath);

        // Evita cache de ES modules
        moduleUrl.searchParams.set(
            't',
            Date.now().toString()
        );

        const newCommand =
            (
                await import(moduleUrl.href)
            ).default;

        client.commands.set(
            commandName,
            newCommand
        );

        logger.info(
            `Reloaded command: ${commandName}`
        );

        return {
            success: true,
            message: `Successfully reloaded command "${commandName}"`
        };

    } catch (error) {

        logger.error(
            `Error reloading command "${commandName}":`,
            error
        );

        return {
            success: false,
            message: `Error reloading command: ${error.message}`
        };
    }
}
