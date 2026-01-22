declare module '*.png' {
    const value: string;
    export default value;
}

declare module '*.css' {
    const classes: Record<string, string>;
    export default classes;
}

declare module '@examples-shared/todo.css';
