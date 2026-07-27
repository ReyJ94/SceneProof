import { inferReactPropsTemplate } from "./react-props.js";

const [, , entry, component] = process.argv;
if (!(entry && component)) {
  throw new Error("Typed props worker requires an entry and component export.");
}

const template = await inferReactPropsTemplate(entry, component);
process.stdout.write(JSON.stringify(template));
