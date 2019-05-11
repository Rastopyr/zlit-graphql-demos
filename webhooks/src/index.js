const yoga = require("graphql-yoga");
const bodyParser = require("body-parser");

const channel = "Rastopyr";
const pubsub = new yoga.PubSub();

const typeDefs = `
  scalar JSON

  type Query {
    GithubWebhook(data: JSON): String
  }

  type Subscription {
    issueComments: GithubComment!
  }

  type GithubComment {
    id: Int
    text: String
    authorName: String
  }
`;

const resolvers = {
  GithubComment: {
    id: (ghc) => ghc.id,
    text: (ghc) => ghc.text,
    authorName: (ghc) => ghc.authorName
  },
  Subscription: {
    issueComments: {
      subscribe: (commentPayload) => {
        return pubsub.asyncIterator(channel);
      }
    }
  },
  Query: {
    GithubWebhook: (_, { data }, { pubsub }) => {
      if (data.comment) {
        pubsub.publish(channel, {
          issueComments: {
            id: data.comment.id,
            text: data.comment.body,
            authorName: data.sender.name
          }
        });
      }

      return "200 OK";
    }
  }
};

const server = new yoga.GraphQLServer({
  typeDefs,
  resolvers,
  context: {
    pubsub
  }
});

/*
  Map payload of webhook to Github resolver
*/
const githubWebhook = (payload) => {
  return {
    query: `
      query GithubHookHandle($payload: JSON) {
        GithubWebhook(data: $payload)
      }
    `,
    variables: {
      payload
    }
  };
};

/*

*/
const handleWebhook = (hookFn) => (req, res, next) => {
  if (!req.body) {
    return next();
  }

  if (!req.body.query) {
    req.body = hookFn(req.body);
  }

  next();
};

server.express.use(bodyParser.json());
server.express.use(handleWebhook(githubWebhook));

server.start({ port: 4001 }, () => console.log("listen at: localhost:4001"));
