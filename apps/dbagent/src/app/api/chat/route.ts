import { UIMessage, appendResponseMessages, createDataStreamResponse, smoothStream, streamText } from 'ai';
import { notFound } from 'next/navigation';
import { NextRequest } from 'next/server';
import { generateTitleFromUserMessage } from '~/app/(main)/projects/[project]/chats/actions';
import { generateUUID } from '~/components/chat/utils';
import { getChatSystemPrompt } from '~/lib/ai/agent';
import { getLanguageModel } from '~/lib/ai/providers';
import { getTools } from '~/lib/ai/tools';
import { deleteChatById, getChatById, getChatsByProject, saveChat } from '~/lib/db/chats';
import { getConnection } from '~/lib/db/connections';
import { getUserSessionDBAccess } from '~/lib/db/db';
import { getProjectById } from '~/lib/db/projects';
import { getTargetDbPool } from '~/lib/targetdb/db';
import { requireUserSession } from '~/utils/route';

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const project = searchParams.get('project');
  if (!project) {
    return new Response('Project is required', { status: 400 });
  }

  const limit = parseInt(searchParams.get('limit') || '10', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  const dbAccess = await getUserSessionDBAccess();

  const chats = await getChatsByProject(dbAccess, { project, limit, offset });

  return Response.json({ chats });
}

export async function POST(request: Request) {
  console.log('POST function started'); // Temporary log
  try {
    const { id, messages, connectionId, model: modelId, useArtifacts } = await request.json();
    console.log('Original messages:', messages); // Temporary log

    const userId = await requireUserSession();
    console.log('User session required'); // Temporary log
    const dbAccess = await getUserSessionDBAccess();
    console.log('DB access obtained'); // Temporary log
    const connection = await getConnection(dbAccess, connectionId);
    if (!connection) {
      console.error('Connection not found', connectionId);
      return new Response('Connection not found', { status: 400 });
    }

    const project = await getProjectById(dbAccess, connection.projectId);
    if (!project) {
      return new Response('Project not found', { status: 400 });
    }

    const userMessage = getMostRecentUserMessage(messages);
    if (!userMessage) {
      return new Response('No user message found', { status: 400 });
    }

    const chat = await getChatById(dbAccess, { id });
    if (!chat) notFound();

    const targetDb = getTargetDbPool(connection.connectionString);
    const context = getChatSystemPrompt({ cloudProvider: project.cloudProvider, useArtifacts });
    const model = await getLanguageModel(modelId);

    // Filtrar mensajes con partes vacías para evitar el error de la API de Gemini
    // Filtrar mensajes con partes vacías para evitar el error de la API de Gemini
    const filteredMessages = messages.filter((message: UIMessage) => message.parts && message.parts.length > 0);
    console.log('Filtered messages:', filteredMessages); // Temporary log

    return createDataStreamResponse({
      execute: async (dataStream) => {
        const tools = await getTools({ project, connection, targetDb, useArtifacts, userId, dataStream });

        const result = streamText({
          model: model.instance(),
          system: context,
          messages: filteredMessages, // Usar los mensajes filtrados
          maxSteps: 20,
          toolCallStreaming: true,
          experimental_transform: smoothStream({ chunking: 'word' }),
          experimental_generateMessageId: generateUUID,
          tools,
          onFinish: async ({ response }) => {
            console.log('Response messages:', response.messages); // Temporary log
            try {
              const assistantId = getTrailingMessageId({
                messages: response.messages.filter((message) => message.role === 'assistant')
              });

              if (!assistantId) {
                throw new Error('No assistant message found!');
              }

              const [, assistantMessage] = appendResponseMessages({
                messages: [userMessage],
                responseMessages: response.messages
              });

              if (!assistantMessage) {
                throw new Error('No assistant message found!');
              }

              const title =
                !chat.title || chat.title === 'New chat'
                  ? await generateTitleFromUserMessage({ message: userMessage })
                  : chat.title;

              await saveChat(
                dbAccess,
                {
                  ...chat,
                  title,
                  model: model.info().id
                },
                [
                  {
                    chatId: id,
                    id: userMessage.id,
                    projectId: connection.projectId,
                    role: 'user',
                    parts: userMessage.parts,
                    createdAt: new Date()
                  },
                  {
                    id: assistantId,
                    projectId: connection.projectId,
                    chatId: id,
                    role: assistantMessage.role,
                    parts: assistantMessage.parts,
                    createdAt: new Date()
                  }
                ]
              );
            } catch (error) {
              console.error('Failed to save chat', error);
            } finally {
              await targetDb.end();
            }
          }
        });

        void result.consumeStream();

        result.mergeIntoDataStream(dataStream, { sendReasoning: true });
      },
      onError: (error) => {
        console.error('Error in data stream:', error);
        return 'An error occurred while processing your request';
      }
    });
  } catch (error) {
    console.error('Error in chat API:', error);
    return new Response('An error occurred while processing your request!', {
      status: 500
    });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  const dbAccess = await getUserSessionDBAccess();

  try {
    const chat = await getChatById(dbAccess, { id });
    if (!chat) notFound();

    await deleteChatById(dbAccess, { id });

    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request!', {
      status: 500
    });
  }
}

export async function PATCH(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  const { title } = await request.json();
  if (!title) {
    return new Response('Title is required', { status: 400 });
  }

  const dbAccess = await getUserSessionDBAccess();

  try {
    const chat = await getChatById(dbAccess, { id });
    if (!chat) notFound();

    await saveChat(dbAccess, { ...chat, title });

    return new Response('Chat updated', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request!', {
      status: 500
    });
  }
}

function getMostRecentUserMessage(messages: Array<UIMessage>) {
  const userMessages = messages.filter((message) => message.role === 'user');
  return userMessages.at(-1);
}

function getTrailingMessageId({ messages }: { messages: Array<{ id: string }> }): string | null {
  const trailingMessage = messages.at(-1);

  if (!trailingMessage) return null;

  return trailingMessage.id;
}
